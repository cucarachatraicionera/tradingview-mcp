import * as db from './db.js';

const NOW = Date.now();
const MONTH_MS = 15 * 24 * 60 * 60 * 1000;
const START = NOW - MONTH_MS;

const INITIAL_CAPITAL = 100;
const RISK_PER_TRADE = 0.01;

const ASSETS = [
  // XAUUSD — Oro (tendencias limpias, SL ajustado)
  { symbol: 'XAUUSD', tf: '30m', base: 3350, drift: 0.04, range: 35,  spd: 3.5, slPct: 0.25, tpPct: 0.55, regimeBase: 60 },
  { symbol: 'XAUUSD', tf: '1h',  base: 3350, drift: 0.04, range: 50,  spd: 2.5, slPct: 0.40, tpPct: 0.90, regimeBase: 65 },
  { symbol: 'XAUUSD', tf: '4h',  base: 3350, drift: 0.04, range: 80,  spd: 1.2, slPct: 0.65, tpPct: 1.50, regimeBase: 70 },

  // SOLUSD — Solana (volátil, SL amplio)
  { symbol: 'SOLUSD', tf: '30m', base: 96, drift: 0.12, range: 8,   spd: 4.0, slPct: 1.8, tpPct: 3.5, regimeBase: 50 },
  { symbol: 'SOLUSD', tf: '1h',  base: 96, drift: 0.12, range: 12,  spd: 2.8, slPct: 2.2, tpPct: 4.2, regimeBase: 55 },
  { symbol: 'SOLUSD', tf: '4h',  base: 96, drift: 0.12, range: 18,  spd: 1.4, slPct: 3.0, tpPct: 5.5, regimeBase: 60 },
];

const HEADLINES = {
  XAUUSD: {
    pos: ['Gold demand surges as central banks increase reserves', 'Safe-haven buying pushes gold higher amid uncertainty', 'Gold breaks key resistance on weak USD data', 'Rate cut expectations fuel gold rally', 'Gold ETF inflows hit 3-month high'],
    neg: ['Gold slides as dollar strengthens', 'Fed hawkish comments pressure gold prices', 'Gold demand slows in Asia session', 'Risk-on sentiment reduces safe-haven appeal', 'Gold technical breakdown signals further downside'],
  },
  SOLUSD: {
    pos: ['Solana DEX volume exceeds $2B weekly', 'SOL ecosystem TVL grows 40% monthly', 'Solana DeFi protocol launches with $500M stake', 'SOL breaks resistance with record volume', 'Institutional interest in Solana ecosystem grows'],
    neg: ['Solana network congestion returns', 'SOL large holders reduce positions', 'Solana faces competition from new L1s', 'SOL technicals show overbought conditions', 'Crypto market rotation away from altcoins'],
  },
};

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const RSI_RANGES = { LONG: [30, 48], SHORT: [55, 78] };

function weightedPick() {
  return Math.random() < 0.58 ? 'won' : 'lost';
}

function calcPositionSize(accountBalance, entryPrice, stopLoss, signalType) {
  const riskAmount = accountBalance * RISK_PER_TRADE; // 1% de la cuenta
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance <= 0) return 0;
  // Position size in units = risk amount / SL distance in price
  const units = riskAmount / slDistance;
  // Notional value
  const notional = units * entryPrice;
  return { units, notional, riskAmount };
}

function generateSignals() {
  const allSignals = [];
  let accountBalance = INITIAL_CAPITAL;
  let newsIdx = {};
  let runningEquity = [{ ts: START, balance: accountBalance }];

  for (const asset of ASSETS) {
    const numSignals = Math.max(8, Math.round(asset.spd * 30 * rand(0.75, 1.25)));
    const usedTimes = new Set();
    newsIdx[asset.symbol] = 0;

    for (let i = 0; i < numSignals; i++) {
      const type = pick(['LONG', 'SHORT']);
      const rsi = type === 'LONG' ? rand(RSI_RANGES.LONG[0], RSI_RANGES.LONG[1]) : rand(RSI_RANGES.SHORT[0], RSI_RANGES.SHORT[1]);

      // Price drift over the month (sinusoidal + linear trend for realism)
      const progress = i / numSignals;
      const drift = asset.base * asset.drift * (progress + Math.sin(progress * Math.PI * 2) * 0.3);
      const entryPrice = Math.round((asset.base + drift + rand(-asset.range, asset.range)) * 100) / 100;
      const slPct = asset.slPct / 100;
      const tpPct = asset.tpPct / 100;

      let stopLoss, takeProfit;
      if (type === 'LONG') {
        stopLoss = Math.round(entryPrice * (1 - slPct) * 100) / 100;
        takeProfit = Math.round(entryPrice * (1 + tpPct) * 100) / 100;
      } else {
        stopLoss = Math.round(entryPrice * (1 + slPct) * 100) / 100;
        takeProfit = Math.round(entryPrice * (1 - tpPct) * 100) / 100;
      }

      const atr = Math.round(entryPrice * rand(0.005, 0.02) * 100) / 100;

      let ts, attempts = 0;
      do { ts = Math.round(START + rand(0, MONTH_MS)); attempts++; }
      while (usedTimes.has(ts) && attempts < 50);
      usedTimes.add(ts);

      // Position sizing with current account balance
      const { units, notional, riskAmount } = calcPositionSize(accountBalance, entryPrice, stopLoss, type);

      const outcome = weightedPick();
      const tfMinutes = asset.tf === '30m' ? 30 : asset.tf === '1h' ? 60 : asset.tf === '2h' ? 120 : 240;
      const barsToExit = Math.floor(rand(4, tfMinutes <= 60 ? 20 : 14));
      const exitTime = ts + barsToExit * tfMinutes * 60 * 1000;

      let exitPrice, pnlDollars, pnlPercent;
      if (outcome === 'won') {
        exitPrice = takeProfit * (1 + rand(-0.001, 0.003));
        const priceMove = type === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
        pnlDollars = units * priceMove;
        pnlPercent = (priceMove / entryPrice) * 100;
      } else {
        exitPrice = stopLoss * (1 + rand(-0.003, 0.001));
        const priceMove = type === 'LONG' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
        pnlDollars = units * priceMove;
        pnlPercent = (priceMove / entryPrice) * 100;
      }
      pnlDollars = Math.round(pnlDollars * 100) / 100;
      pnlPercent = Math.round(pnlPercent * 100) / 100;

      // Update account balance
      accountBalance += pnlDollars;
      accountBalance = Math.max(0, accountBalance);

      // Neural Matrix Pro fields
      const confidence = Math.round(Math.min(95, Math.max(55, 65 + rand(-12, 15) + (outcome === 'won' ? 5 : -3))));
      const regimeScore = Math.round(Math.min(100, Math.max(10, asset.regimeBase + rand(-15, 18))));

      // News headline
      const headlines = HEADLINES[asset.symbol] || { pos: ['Market update'], neg: ['Market update'] };
      const newsList = type === 'LONG' ? headlines.pos : headlines.neg;
      const headline = newsList[newsIdx[asset.symbol] % newsList.length];
      newsIdx[asset.symbol]++;

      allSignals.push({
        symbol: asset.symbol, timestamp: ts,
        signalType: type,
        entryPrice, stopLoss, takeProfit, rsi, atr,
        confidence, regimeScore,
        newsHeadline: headline,
        newsUrl: `https://www.tradingview.com/symbols/${asset.symbol}/`,
        newsSentiment: type === 'LONG' ? 'positive' : 'negative',
        status: outcome,
        exitPrice: Math.round(exitPrice * 100) / 100,
        exitTime, pnl: pnlDollars, pnlPercent, barsToExit,
        tf: asset.tf,
        units: Math.round(units * 100000) / 100000,
        notional: Math.round(notional * 100) / 100,
        accountAfter: Math.round(accountBalance * 100) / 100,
      });

      runningEquity.push({ ts: exitTime, balance: Math.round(accountBalance * 100) / 100 });
    }
  }

  return { signals: allSignals.sort((a, b) => a.timestamp - b.timestamp), runningEquity };
}

async function main() {
  const { signals, runningEquity } = generateSignals();

  console.log(`🧠 NEURAL MATRIX PRO — Simulación con $${INITIAL_CAPITAL} USD\n`);

  const counts = {};
  for (const s of signals) {
    if (!counts[s.symbol]) counts[s.symbol] = { total: 0, won: 0, lost: 0 };
    counts[s.symbol].total++;
    counts[s.symbol][s.status]++;
  }

  console.log('Señales por activo:');
  for (const a of ASSETS) {
    const c = counts[a.symbol] || { total: 0, won: 0, lost: 0 };
    const wr = c.total > 0 ? ((c.won / c.total) * 100).toFixed(1) : '0.0';
    console.log(`  ${a.symbol} (${a.tf}): ${c.total} | ${c.won}W/${c.lost}L | WR: ${wr}%`);
  }

  console.log('\nPosición inicial: $100.00');
  console.log('Riesgo por trade: 1% de la cuenta');
  console.log('');

  // Insert signals into DB
  for (const s of signals) {
    const id = db.insertSignal({
      symbol: s.symbol, tf: s.tf,
      signalType: s.signalType,
      entryPrice: s.entryPrice,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      rsi: s.rsi,
      atr: s.atr,
      confidence: s.confidence,
      regimeScore: s.regimeScore,
      newsHeadline: s.newsHeadline,
      newsUrl: s.newsUrl,
      newsSentiment: s.newsSentiment,
    });
    db.resolveSignal(id, {
      status: s.status,
      exitPrice: s.exitPrice,
      exitTime: s.exitTime,
      pnl: s.pnl,
      pnlPercent: s.pnlPercent,
      barsToExit: s.barsToExit,
    });
  }

  const stats = db.getStats();
  const finalBalance = runningEquity[runningEquity.length - 1]?.balance || 100;
  const totalReturn = ((finalBalance - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100).toFixed(2);
  const maxDrawdown = calcMaxDrawdown(runningEquity);

  console.log('\n═══════════════════════════════════════════');
  console.log('  INFORME DE SIMULACIÓN — 15 DÍAS | $100 USD');
  console.log('═══════════════════════════════════════════');
  console.log(`  Capital inicial:    $${INITIAL_CAPITAL}.00`);
  console.log(`  Capital final:      $${finalBalance.toFixed(2)}`);
  console.log(`  Retorno total:      ${totalReturn}%`);
  console.log(`  Ganadas:            ${stats.won}`);
  console.log(`  Perdidas:           ${stats.lost}`);
  console.log(`  Win Rate:           ${stats.winRate}%`);
  console.log(`  P&L Total:          $${stats.totalPnl}`);
  console.log(`  Drawdown Máximo:    ${maxDrawdown}%`);
  console.log(`  Total operaciones:  ${stats.total}`);
  console.log('');

  // Mostrar las primeras 10 operaciones como ejemplo
  console.log('Primeras 10 operaciones:');
  console.log(' #  | Símbolo | Tipo  | Entrada   | SL        | TP        | Resultado  | P&L     | Balance');
  console.log('────┼─────────┼───────┼───────────┼───────────┼───────────┼────────────┼─────────┼────────');
  signals.slice(0, 10).forEach((s, i) => {
    const res = s.status === 'won' ? '✅ GANÓ' : '❌ PERDIÓ';
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
    console.log(` ${i+1}. | ${s.symbol} | ${s.signalType === 'LONG' ? 'LONG ' : 'SHORT'} | $${s.entryPrice.toFixed(2)} | $${s.stopLoss.toFixed(2)} | $${s.takeProfit.toFixed(2)} | ${res} | ${pnlStr} | $${s.accountAfter.toFixed(2)}`);
  });
}

function calcMaxDrawdown(equityCurve) {
  let peak = equityCurve[0]?.balance || 100;
  let maxDd = 0;
  for (const e of equityCurve) {
    if (e.balance > peak) peak = e.balance;
    const dd = ((peak - e.balance) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd.toFixed(2);
}

main().catch(console.error);
