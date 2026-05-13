import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIND_MONACO = `(function fme(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return null;var e=c,fk;for(var i=0;i<20;i++){if(!e)break;fk=Object.keys(e).find(function(k){return k.startsWith("__reactFiber$");});if(fk)break;e=e.parentElement;}if(!fk)return null;var cur=e[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0)return{editor:eds[0],env:env};}}cur=cur.return;}return null;})()`;

export async function ensureIndicatorOnChart({
  indicatorName = 'Neural Matrix Pro [Bot]',
  pinePath = resolve(__dirname, '../strategies/neural_matrix_pro.pine'),
  cdpPort = 9222,
} = {}) {
  const pineCode = readFileSync(pinePath, 'utf8');
  const resp = await fetch(`http://localhost:${cdpPort}/json/list`);
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url) && /chart/i.test(t.url));
  if (!target) throw new Error('TradingView chart page not found on CDP port ' + cdpPort);

  const c = await CDP({ host: 'localhost', port: cdpPort, target: target.id });
  await c.Runtime.enable();

  async function expr(exp) {
    const r = await c.Runtime.evaluate({ expression: exp, returnByValue: true });
    return r.result?.value;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Check if indicator exists on chart
  const checkExists = async () => {
    // Try dataSources first (same as readSignalFromChart)
    const dsCheck = await expr(`(function(){
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var sources = chart._chartWidget.model().model().dataSources();
        for(var i=0;i<sources.length;i++){
          try {
            if(typeof sources[i].metaInfo !== 'function') continue;
            var m = sources[i].metaInfo();
            if(m && (m.description || '').indexOf('Neural Matrix') >= 0) {
              var id = typeof sources[i].id === 'function' ? sources[i].id() : sources[i].id;
              return JSON.stringify({name: m.description, id: id});
            }
          } catch(e) {}
        }
      } catch(e) { return 'ERR:' + e.message; }
      return 'NOT_FOUND';
    })()`);
    if (dsCheck && dsCheck !== 'NOT_FOUND' && !dsCheck.startsWith('ERR:')) return JSON.parse(dsCheck);

    // Fallback to getAllStudies
    const allCheck = await expr(`(function(){
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var studies = chart.getAllStudies();
        for(var i=0;i<studies.length;i++){
          if((studies[i].name || '').indexOf('Neural Matrix') >= 0) {
            return JSON.stringify({name: studies[i].name, id: studies[i].id});
          }
        }
      } catch(e) { return 'ERR:' + e.message; }
      return 'NOT_FOUND';
    })()`);
    if (allCheck && allCheck !== 'NOT_FOUND' && !allCheck.startsWith('ERR:')) return JSON.parse(allCheck);

    return null;
  };

  const existing = await checkExists();
  if (existing) {
    console.log('Indicator already on chart:', existing.name, existing.id);
    await c.close();
    return { loaded: true, entityId: existing.id, method: 'already_exists' };
  }
  // Fallback: check via getAllStudies
  const fallbackCheck = await expr(`JSON.stringify(window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return {id:s.id,name:s.name};}))`);
  const fallbackParsed = JSON.parse(fallbackCheck || '[]');
  const fallbackExisting = fallbackParsed.find(s => s.name === indicatorName);
  if (fallbackExisting) {
    console.log('Indicator found via fallback:', fallbackExisting.id);
    await c.close();
    return { loaded: true, entityId: fallbackExisting.id, method: 'already_exists' };
  }
  console.log('Indicator not found on chart, will add it...');

  // Open Pine Editor
  await expr(`document.querySelector('[aria-label="Pine"],[data-name="pine-dialog-button"]')?.click()`);
  await sleep(3000);

  // Inject source code via Monaco
  const injected = await expr(`(function(){var m=${FIND_MONACO};if(m){m.editor.setValue(${JSON.stringify(pineCode)});return true;}return false;})()`);
  if (!injected) { await c.close(); throw new Error('Could not find Monaco editor to inject code'); }
  await sleep(2000);

  // Trigger "Add to chart" via Monaco action
  const triggerResult = await expr(`(function(){
    var m = ${FIND_MONACO};
    if(!m) return 'NO_EDITOR';
    var editor = m.editor;
    var actions = editor.getActions() || [];
    for(var a of actions) {
      if(a.id.indexOf('add.to.chart') >= 0) {
        a.run();
        return 'triggered:' + a.id;
      }
    }
    return 'ACTION_NOT_FOUND';
  })()`);
  console.log('Add to chart trigger:', triggerResult);
  await sleep(5000);

  // Handle possible save dialog (first-time save asks for name)
  const dialogHandled = await expr(`(function(){
    var dialog = document.querySelector('[role="dialog"]');
    if(!dialog) return 'NO_DIALOG';
    var input = dialog.querySelector('input');
    if(!input) return 'NO_INPUT';
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, ${JSON.stringify(indicatorName)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
    // Click Save
    var btns = dialog.querySelectorAll('button');
    for(var b of btns) {
      if((b.textContent||'').trim() === 'Save' && b.offsetParent !== null) {
        b.click();
        return 'SAVE_CLICKED';
      }
    }
    return 'SAVE_BUTTON_NOT_FOUND';
  })()`);
  if (dialogHandled !== 'NO_DIALOG') {
    console.log('Save dialog handled:', dialogHandled);
    await sleep(3000);
  }

  // Verify the indicator was added (retry with delays)
  let added = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    added = await checkExists();
    if (added) break;
    // Also try via getAllStudies as fallback
    if (!added) {
      const fallback = await expr(`JSON.stringify(window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return {id:s.id,name:s.name};}))`);
      const parsed = JSON.parse(fallback || '[]');
      added = parsed.find(s => s.name === indicatorName) || null;
      if (added) added.name = indicatorName;
    }
    if (added) break;
    await sleep(2000);
  }
  await c.close();

  if (!added) throw new Error('Indicator was not added to chart after triggering add.to.chart');
  return { loaded: true, entityId: added.id, method: 'monaco_action' };
}
