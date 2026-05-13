/* Start everything from scratch:
   1. Kill old processes, clean DB
   2. Load indicator onto chart
   3. Start dashboard in background
   4. Start signals-bot in background
*/

import { execSync, spawn } from 'child_process';
import { unlinkSync, existsSync, readFileSync } from 'fs';
import CDP from 'chrome-remote-interface';

const ROOT = '/home/m/Documents/tradingviewmcp';

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 1. Clean up old processes
  log('Cleaning old processes...');
  try { execSync('pkill -f "node.*dashboard/server" 2>/dev/null', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -f "node.*signals-bot" 2>/dev/null', { stdio: 'ignore' }); } catch {}
  await sleep(1000);

  // 2. Clean DB
  log('Cleaning database...');
  for (const f of ['signals.db', 'signals.db-wal', 'signals.db-shm']) {
    const p = `${ROOT}/data/${f}`;
    if (existsSync(p)) unlinkSync(p);
  }

  // 3. Check CDP
  log('Checking TradingView CDP...');
  let targetId;
  try {
    const resp = await fetch('http://localhost:9222/json/list');
    const targets = await resp.json();
    const target = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url) && /chart/i.test(t.url));
    if (!target) { log('ERROR: TradingView not found on CDP. Open TradingView with --remote-debugging-port=9222'); process.exit(1); }
    targetId = target.id;
    log('TradingView found');
  } catch (e) {
    log('ERROR: Cannot connect to CDP: ' + e.message);
    process.exit(1);
  }

  // 4. Load indicator onto chart
  log('Loading Neural Matrix Pro onto chart...');
  const c = await CDP({ host: 'localhost', port: 9222, target: targetId });
  await c.Runtime.enable();

  const FIND = `(function fme(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return null;var e=c,fk;for(var i=0;i<20;i++){if(!e)break;fk=Object.keys(e).find(function(k){return k.startsWith("__reactFiber$");});if(fk)break;e=e.parentElement;}if(!fk)return null;var cur=e[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0)return{editor:eds[0],env:env};}}cur=cur.return;}return null;})()`;

  async function evalExpr(exp) {
    const r = await c.Runtime.evaluate({ expression: exp, returnByValue: true });
    return r.result?.value;
  }

  // Check if already loaded
  const studiesBefore = await evalExpr(`JSON.stringify(window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s=>s.name))`);
  log('Studies before: ' + studiesBefore);

  if (studiesBefore && studiesBefore.includes('Neural Matrix Pro')) {
    log('Indicator already on chart.');
  } else {
    // Open Pine Editor
    await evalExpr(`document.querySelector('[aria-label="Pine"],[data-name="pine-dialog-button"]')?.click()`);
    await sleep(3000);

    // Inject code
    const pineCode = readFileSync(`${ROOT}/strategies/neural_matrix_pro.pine`, 'utf8');
    const setOk = await evalExpr(`(function(){var m=${FIND};if(m){m.editor.setValue(${JSON.stringify(pineCode)});return true;}return false;})()`);
    log('Source injected: ' + setOk);
    await sleep(2000);

    // Check markers
    const markers = await evalExpr(`(function(){var m=${FIND};if(!m)return'[]';var model=m.editor.getModel();if(!model)return'[]';var ms=m.env.editor.getModelMarkers({resource:model.uri});return JSON.stringify(ms.map(function(x){return{line:x.startLineNumber,sev:x.severity,msg:x.message.substring(0,80)};}));})()`);
    log('Markers: ' + markers);

    // Save via Ctrl+S
    await evalExpr(`document.querySelector('.monaco-editor textarea')?.focus()`);
    await sleep(500);
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
    log('Ctrl+S sent');
    await sleep(2000);

    // Check for save dialog
    const dialog = await evalExpr(`(()=>{
      var d = document.querySelectorAll('[role="dialog"]');
      for(var dd of d) { if(dd.offsetParent !== null) return JSON.stringify({hasInput:!!dd.querySelector('input')}); }
      return 'NONE';
    })()`);
    log('Dialog: ' + dialog);

    if (dialog !== 'NONE') {
      const d = JSON.parse(dialog);
      if (d.hasInput) {
        await evalExpr(`(()=>{
          var inp = document.querySelector('[role="dialog"] input');
          if(inp) { var ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; ns.call(inp,'Neural Matrix Pro'); inp.dispatchEvent(new Event('input',{bubbles:true})); }
        })()`);
        await sleep(500);
        await evalExpr(`(()=>{var btns=document.querySelectorAll('[role="dialog"] button');for(var b of btns){if((b.textContent||'').trim()==='Save'){b.click();return;}}})()`);
        await sleep(3000);
      }
    }

    // Try to add to chart: click Save button in editor
    await evalExpr(`(()=>{
      var btns = document.querySelectorAll('button');
      for(var b of btns) {
        var cls = b.className || '';
        if(cls.indexOf('saveButton') >= 0 && cls.indexOf('hidden') === -1 && b.offsetParent !== null) {
          b.click(); return 'CLICKED saveButton';
        }
      }
      return 'NO_SAVEBUTTON';
    })()`);
    await sleep(2000);

    // Check again
    const studiesAfter = await evalExpr(`JSON.stringify(window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s=>s.name))`);
    log('Studies after: ' + studiesAfter);
  }

  await c.close();

  // 5. Start dashboard
  log('Starting dashboard...');
  const dashboard = spawn('node', ['bot/dashboard/server.js'], {
    cwd: ROOT, stdio: 'ignore', detached: true
  });
  dashboard.unref();
  await sleep(2000);
  log('Dashboard PID: ' + dashboard.pid);

  // 6. Start bot
  log('Starting signals bot...');
  const bot = spawn('node', ['bot/signals-bot.js'], {
    cwd: ROOT, stdio: 'ignore', detached: true
  });
  bot.unref();
  await sleep(1000);
  log('Bot PID: ' + bot.pid);

  log('');
  log('═══════════════════════════════════');
  log('  Todo arrancado desde cero!');
  log('  Dashboard: http://localhost:3456');
  log('  Bot recogiendo señales...');
  log('═══════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
