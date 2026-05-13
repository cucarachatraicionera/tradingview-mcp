#!/usr/bin/env node

import CDP from 'chrome-remote-interface';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import { getNewsForSignal } from './news.js';
import { ensureIndicatorOnChart } from './load-indicator.js';
import * as exchange from './exchange.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(__dirname, '../.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const [k, ...v] = line.split('=');
      if (k && v.length && !k.startsWith('#')) {
        process.env[k.trim()] = v.join('=').trim();
      }
    }
  }
}
loadEnv();

const CONFIG = {
  telegram: {
    token:  process.env.TELEGRAM_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT  || '',
  },
  cdp: {
    host: 'localhost',
    port: parseInt(process.env.CDP_PORT || '9222'),
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL || '120') * 1000,
  dryRun: process.env.DRY_RUN === 'true',
  indicatorName: process.env.INDICATOR_NAME || 'Neural Matrix Pro [Bot]',
};

const COMBOS = [
  { symbol: 'XAUUSD', tf: '30' },
  { symbol: 'XAUUSD', tf: '60' },
  { symbol: 'XAUUSD', tf: '240' },
  { symbol: 'SOLUSD', tf: '30' },
  { symbol: 'SOLUSD', tf: '60' },
  { symbol: 'SOLUSD', tf: '240' },
];
const lastSignals = {};
let totalSignals = 0;
let cdpClient = null;

async function getCdpClient() {
  if (cdpClient) {
    try { await cdpClient.Runtime.evaluate({ expression: '1+1', returnByValue: true }); return cdpClient; }
    catch { cdpClient = null; }
  }
  const resp = await fetch(`http://${CONFIG.cdp.host}:${CONFIG.cdp.port}/json/list`);
  const targets = await resp.json();
  const target = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
             || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
  if (!target) throw new Error('TradingView no está abierto. Lanza TradingView con --remote-debugging-port=9222');
  cdpClient = await CDP({ host: CONFIG.cdp.host, port: CONFIG.cdp.port, target: target.id });
  await cdpClient.Runtime.enable();
  return cdpClient;
}

async function evaluate(expression) {
  const c = await getCdpClient();
  const result = await c.Runtime.evaluate({ expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'JS error');
  return result.result?.value;
}

async function switchSymbol(symbol, timeframe) {
  await evaluate(`
    (function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(r){
        chart.setSymbol(${JSON.stringify(symbol)}, {});
        setTimeout(function(){
          chart.setResolution(${JSON.stringify(timeframe)}, {});
          setTimeout(r, 2000);
        }, 1500);
      });
    })()
  `);
  await new Promise(r => setTimeout(r, 2000));
}

async function readSignalFromChart() {
  const script = `
    (()=>{
      try{
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if(!chart) return null;
        var sources = chart._chartWidget.model().model().dataSources();
        if(!sources) return null;
        var ind = sources.find(function(s){
          try {
            if(typeof s.metaInfo !== 'function') return false;
            var m = s.metaInfo();
            return m && (m.description || m.shortDescription || '').indexOf('Neural Matrix') >= 0;
          } catch(e) { return false; }
        });
        if(!ind) return {error:'indicator_not_found'};
        var dw = ind.dataWindowView();
        if(!dw) return {error:'no_data_window'};
        var items = dw.items();
        if(!items || !items.length) return {error:'no_data'};
        var v = {};
        for(var i=0;i<items.length;i++){
          var it = items[i];
          if(it._title && it._value !== '\u2205') v[it._title] = parseFloat((it._value+'').replace(',','.')) || 0;
        }
        var ms = chart._chartWidget.model().mainSeries();
        var bars = ms.bars().last().value;
        var close = bars ? parseFloat((bars[4]+'').replace(',','.')) : null;
        return {
          price: close,
          time: Date.now()/1000,
          signal: v['Signal'] || 0,
          rsi: v['RSI'] || 0,
          atr: v['ATR'] || 0,
          atrPct: v['ATR%'] || 0,
          regime: v['Regime'] || 0,
          confidence: Math.round(v['Confidence']) || 0,
          volRatio: v['VolRatio'] || 0,
          adx: v['ADX'] || 0,
          chop: v['Choppiness'] || 0,
          longSL: v['Long_SL'] || 0,
          longTP: v['Long_TP'] || 0,
          shortSL: v['Short_SL'] || 0,
          shortTP: v['Short_TP'] || 0
        };
      }catch(e){return {error:e.message};}
    })()
  `;
  return await evaluate(script);
}

async function getCurrentPrice(symbol, timeframe) {
  try {
    await switchSymbol(symbol, timeframe);
    return await evaluate(`
      (()=>{
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var bars = chart._chartWidget.model().mainSeries().bars().last().value;
        return bars ? bars[4] : null;
      })()
    `);
  } catch { return null; }
}

async function sendTelegram(message) {
  if (CONFIG.dryRun) { console.log('[DRY RUN]', message); return; }
  if (!CONFIG.telegram.token || !CONFIG.telegram.chatId) { return; }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId, text: message,
        parse_mode: 'HTML', disable_web_page_preview: false,
      }),
    });
    const data = await resp.json();
    if (!data.ok) console.error('Telegram error:', data.description);
  } catch (e) { console.error('Telegram fetch error:', e.message); }
}

function fmtSignalMsg(data, symbol, news) {
  const side = data.signal === 1 ? 'LONG 🟢' : 'SHORT 🔴';
  const emoji = data.signal === 1 ? '📈' : '📉';
  const sl = data.signal === 1 ? data.longSL : data.shortSL;
  const tp = data.signal === 1 ? data.longTP : data.shortTP;
  const rr = tp && sl ? Math.abs((tp - data.price) / (sl - data.price || 1)).toFixed(2) : '—';

  const trendEmoji = data.regime > 60 ? '📊' : data.regime > 35 ? '📉' : '⚠️';
  const regimeLabel = data.regime > 60 ? 'Tendencia Fuerte' : data.regime > 35 ? 'Tendencia Débil' : 'Sin Tendencia';
  const confStars = data.confidence >= 80 ? '⭐⭐⭐' : data.confidence >= 65 ? '⭐⭐' : '⭐';

  let msg = `${emoji} <b>SEÑAL ${side}</b>  ${confStars}

🏷️ <b>Activo:</b> ${symbol}
💰 <b>Entrada:</b> $${data.price.toFixed(2)}
🎯 <b>Take Profit:</b> $${tp.toFixed(2)}
🛑 <b>Stop Loss:</b> $${sl.toFixed(2)}
📐 <b>R/R:</b> 1:${rr}

📊 <b>Confianza:</b> ${data.confidence}% | <b>RSI:</b> ${data.rsi.toFixed(1)}
${trendEmoji} <b>Régimen:</b> ${regimeLabel} (${Math.round(data.regime)})
📈 <b>Vol Ratio:</b> ${data.volRatio.toFixed(2)}x | <b>ADX:</b> ${data.adx.toFixed(1)}

🧠 <i>Neural Matrix Pro — Multi-Factor</i>`;

  if (news && news.length > 0) {
    const top = news[0];
    msg += `\n\n📰 <b>Noticia relacionada:</b>\n${top.emoji} ${top.title}`;
    if (top.url && !top.isFallback) {
      msg += `\n🔗 <a href="${top.url}">Abrir noticia</a>`;
    }
  }

  msg += `\n🕐 ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}
⚠️ <i>Solo educativo. No es consejo financiero.</i>`;

  return msg;
}

function fmtResultMsg(signal, resultType, exitPrice) {
  const won = resultType === 'won';
  const pct = signal.pnl_percent >= 0 ? `+${Number(signal.pnl_percent).toFixed(2)}` : `${Number(signal.pnl_percent).toFixed(2)}`;
  const pnl = signal.pnl >= 0 ? `+$${Number(signal.pnl).toFixed(2)}` : `-$${Math.abs(signal.pnl).toFixed(2)}`;

  let msg = `${won ? '✅' : '❌'} <b>RESULTADO: ${won ? 'GANANCIA 🟢' : 'PÉRDIDA 🔴'}</b>

📊 <b>Par:</b> ${signal.symbol}
📈 <b>Señal:</b> ${signal.signal_type}
💰 <b>Entrada:</b> $${Number(signal.entry_price).toFixed(2)}
🎯 <b>Salida:</b> $${Number(exitPrice).toFixed(2)}
💵 <b>P&L:</b> ${pnl} (${pct}%)
${signal.bars_to_exit ? `📊 <b>Velas hasta salida:</b> ${signal.bars_to_exit}` : ''}
📊 <b>Confianza entrada:</b> ${signal.confidence || 'N/A'}% | <b>RSI:</b> ${signal.rsi || 'N/A'}`;

  if (signal.news_headline) {
    msg += `\n\n📰 <b>Noticia al momento:</b>\n${signal.news_headline}`;
    if (signal.news_url) msg += `\n🔗 <a href="${signal.news_url}">Abrir</a>`;
  }

  msg += `\n\n🧠 <i>Neural Matrix Pro</i>
🕐 ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`;

  return msg;
}

function timestamp() {
  return new Date().toLocaleTimeString('es-MX', { hour12: false });
}

async function checkPendingSignals(priceCache, useExchangePrice = true) {
  const pending = db.getPendingSignals();
  for (const sig of pending) {
    try {
      let price = priceCache[sig.symbol];
      if (!price && useExchangePrice && process.env.BINANCE_API_KEY) {
        price = await exchange.getCurrentPrice(sig.symbol);
      }
      if (!price) price = priceCache[sig.symbol] || await getCurrentPrice(sig.symbol);
      if (!price) continue;
      priceCache[sig.symbol] = price;

      const isLong = sig.signal_type === 'LONG';
      const hitTP = isLong ? price >= sig.take_profit : price <= sig.take_profit;
      const hitSL = isLong ? price <= sig.stop_loss : price >= sig.stop_loss;

      if (hitTP) {
        const pnl = isLong ? (sig.take_profit - sig.entry_price) : (sig.entry_price - sig.take_profit);
        db.resolveSignal(sig.id, {
          status: 'won', exitPrice: sig.take_profit, exitTime: Date.now(),
          pnl: Math.round(pnl * 100) / 100, pnlPercent: Math.round((pnl / sig.entry_price) * 10000) / 100,
          barsToExit: Math.round((Date.now() - sig.timestamp) / 60000),
        });
        const updated = db.getAllSignals(1)[0];
        await sendTelegram(fmtResultMsg(updated, 'won', sig.take_profit));
        console.log(`[${timestamp()}] ✅ ${sig.symbol} TP alcanzado: +$${pnl.toFixed(2)}`);
      } else if (hitSL) {
        const pnl = isLong ? (sig.stop_loss - sig.entry_price) : (sig.entry_price - sig.stop_loss);
        db.resolveSignal(sig.id, {
          status: 'lost', exitPrice: sig.stop_loss, exitTime: Date.now(),
          pnl: Math.round(pnl * 100) / 100, pnlPercent: Math.round((pnl / sig.entry_price) * 10000) / 100,
          barsToExit: Math.round((Date.now() - sig.timestamp) / 60000),
        });
        const updated = db.getAllSignals(1)[0];
        await sendTelegram(fmtResultMsg(updated, 'lost', sig.stop_loss));
        console.log(`[${timestamp()}] ❌ ${sig.symbol} SL alcanzado: ${pnl.toFixed(2)}`);
      }
    } catch (e) {
      console.error(`[${timestamp()}] Error reviendo ${sig.symbol}:`, e.message);
    }
  }
}

async function checkCombo(combo) {
  const key = `${combo.symbol}_${combo.tf}`;
  try {
    console.log(`[${timestamp()}] 🔄 ${combo.symbol} ${combo.tf}...`);
    await switchSymbol(combo.symbol, combo.tf);

    const data = await readSignalFromChart();
    if (!data || data.error === 'indicator_not_found') {
      if (data) {
        console.log(`[${timestamp()}] ⚠️ ${combo.symbol} ${combo.tf}: indicador no cargado, reintentando...`);
        try {
          await ensureIndicatorOnChart({ indicatorName: CONFIG.indicatorName, cdpPort: CONFIG.cdp.port });
          console.log(`[${timestamp()}] ✅ ${combo.symbol} ${combo.tf}: indicador recargado`);
        } catch (reloadErr) {
          console.log(`[${timestamp()}] ❌ ${combo.symbol} ${combo.tf}: no se pudo recargar: ${reloadErr.message}`);
        }
      }
      return;
    }
    if (data.error) { console.log(`[${timestamp()}] ${combo.symbol} ${combo.tf}: error ${data.error}`); return; }

    const signal = data.signal || 0;
    const prev = lastSignals[key] || 0;
    const sigLabel = signal === 1 ? 'LONG 🟢' : signal === -1 ? 'SHORT 🔴' : 'NEUTRO ⚪';
    console.log(`[${timestamp()}] ${combo.symbol} ${combo.tf} | ${sigLabel} | Conf: ${data.confidence}% | RSI: ${data.rsi?.toFixed(1)} | $${data.price}`);

    if (signal !== 0 && signal !== prev) {
      totalSignals++;
      const signalType = signal === 1 ? 'LONG' : 'SHORT';
      const sl = signal === 1 ? data.longSL : data.shortSL;
      const tp = signal === 1 ? data.longTP : data.shortTP;

      console.log(`  🚨 SEÑAL #${totalSignals}: ${signalType} ${combo.symbol} ${combo.tf} (conf: ${data.confidence}%)`);

      const news = await getNewsForSignal(combo.symbol, signalType);
      const msg = fmtSignalMsg(data, combo.symbol, news);
      await sendTelegram(msg);

      const newsItem = news && news.length > 0 ? news[0] : null;

      db.insertSignal({
        symbol: combo.symbol, tf: combo.tf, signalType,
        entryPrice: data.price,
        stopLoss: sl, takeProfit: tp,
        rsi: data.rsi, atr: data.atr,
        confidence: data.confidence,
        regimeScore: Math.round(data.regime),
        newsHeadline: newsItem?.title || null,
        newsUrl: newsItem?.url || null,
        newsSentiment: newsItem?.sentiment || null,
      });

      if (CONFIG.dryRun) {
        console.log(`  [DRY RUN] Binance trade would execute: ${signalType} ${combo.symbol} at $${data.price}`);
      } else if (process.env.BINANCE_API_KEY) {
        try {
          const trade = signalType === 'LONG'
            ? await exchange.openLong(combo.symbol, data.price, sl, tp)
            : await exchange.openShort(combo.symbol, data.price, sl, tp);
          if (trade.success) {
            console.log(`  ✅ Binance ${signalType} abierto: size=${trade.size} entry=$${data.price}`);
            if (sl) await exchange.setStopLoss(combo.symbol, signalType, trade.size, sl);
            if (tp) await exchange.setTakeProfit(combo.symbol, signalType, trade.size, tp);
          } else {
            console.error(`  ❌ Binance error: ${trade.error}`);
          }
        } catch (e) {
          console.error(`  ❌ Binance exception: ${e.message}`);
        }
      }

      lastSignals[key] = signal;
    } else if (signal === 0 && prev !== 0) {
      lastSignals[key] = 0;
    }
  } catch (e) {
    console.error(`[${timestamp()}] ${combo.symbol} ${combo.tf}:`, e.message);
    cdpClient = null;
  }
}

async function tick() {
  const priceCache = {};
  for (const combo of COMBOS) {
    await checkCombo(combo);
  }
  await checkPendingSignals(priceCache);
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Neural Matrix Pro — Signals Bot           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`📡 CDP:       localhost:${CONFIG.cdp.port}`);
  console.log(`⏱  Intervalo: ${CONFIG.pollInterval / 1000}s`);
  console.log(`📬 Telegram:  ${CONFIG.telegram.token ? '✅' : '❌'}`);
  console.log(`🗄️  DB:        data/signals.db`);
  console.log(`📊 Dashboard: http://localhost:3456`);
  console.log(`🧠 Estrategia: Neural Matrix Pro`);
  console.log(`🪙 Combos:    ${COMBOS.map(c => `${c.symbol} ${c.tf}`).join(', ')}`);
  console.log(`📰 Noticias:   ${CONFIG.telegram.token ? '✅' : '❌'}`);
  if (process.env.BINANCE_API_KEY) {
    console.log(`🪙 Binance:    ✅ (testnet: ${process.env.BINANCE_TESTNET === 'true' ? 'sí' : 'no'}, apalancamiento: ${process.env.BINANCE_LEVERAGE || 5}x)`);
  } else {
    console.log(`🪙 Binance:    ❌ (sin API keys — solo monitoreo)`);
  }
  console.log('');

  try {
    const result = await ensureIndicatorOnChart({ indicatorName: CONFIG.indicatorName });
    console.log(`📊 Indicador: ${result.loaded ? '✅' : '❌'} (${result.method})`);
  } catch (e) {
    console.log(`📊 Indicador: ⚠️ No se pudo cargar: ${e.message}`);
  }
  console.log('');

  await tick();
  setInterval(tick, CONFIG.pollInterval);

  process.on('SIGINT', () => {
    console.log('\n👋 Deteniendo bot...');
    process.exit(0);
  });
}

main().catch(console.error);
