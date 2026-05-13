import ccxt from 'ccxt';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYMBOL_MAP = {
  'XAUUSD': 'XAUUSDT',
  'SOLUSD': 'SOLUSDT',
};

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

const CONFIG = {
  apiKey: process.env.BINANCE_API_KEY || '',
  secret: process.env.BINANCE_SECRET_KEY || '',
  testnet: process.env.BINANCE_TESTNET === 'true',
  leverage: parseInt(process.env.BINANCE_LEVERAGE || '5'),
  riskPercent: parseFloat(process.env.BINANCE_RISK_PERCENT || '2'),
};

let exchange = null;

function getExchange() {
  if (exchange) return exchange;
  if (!CONFIG.apiKey || !CONFIG.secret) {
    console.warn('[EXCHANGE] Binance API keys not configured — trades will not execute');
    return null;
  }
  exchange = new ccxt.binanceusdm({
    apiKey: CONFIG.apiKey,
    secret: CONFIG.secret,
    options: { defaultType: 'future' },
  });
  if (CONFIG.testnet) {
    exchange.urls.api = exchange.urls.test;
  }
  return exchange;
}

export async function getBalance() {
  const ex = getExchange();
  if (!ex) return null;
  try {
    const balance = await ex.fetchBalance();
    const usdt = balance.USDT || { total: 0, free: 0 };
    return { total: usdt.total, free: usdt.free };
  } catch (e) {
    console.error('[EXCHANGE] getBalance error:', e.message);
    return null;
  }
}

export async function getPosition(symbol) {
  const ex = getExchange();
  if (!ex) return null;
  try {
    const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
    const positions = await ex.fetchPositions([binanceSymbol]);
    const pos = positions.find(p => p.symbol === binanceSymbol);
    if (!pos || pos.contracts === 0) return null;
    return {
      symbol,
      side: pos.side === 'long' ? 'LONG' : 'SHORT',
      size: pos.contracts,
      entryPrice: pos.entryPrice,
      markPrice: pos.markPrice,
      liquidationPrice: pos.liquidationPrice,
      pnl: pos.unrealizedPnl,
      pnlPercent: pos.percentage,
    };
  } catch (e) {
    console.error(`[EXCHANGE] getPosition ${symbol} error:`, e.message);
    return null;
  }
}

export async function getOpenPositions() {
  const ex = getExchange();
  if (!ex) return [];
  try {
    const positions = await ex.fetchPositions();
    return positions
      .filter(p => p.contracts > 0)
      .map(p => ({
        symbol: Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k] === p.symbol) || p.symbol,
        binanceSymbol: p.symbol,
        side: p.side === 'long' ? 'LONG' : 'SHORT',
        size: p.contracts,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        pnl: p.unrealizedPnl,
      }));
  } catch (e) {
    console.error('[EXCHANGE] getOpenPositions error:', e.message);
    return [];
  }
}

async function setLeverage(symbol) {
  const ex = getExchange();
  if (!ex) return;
  try {
    await ex.setLeverage(CONFIG.leverage, symbol);
  } catch (e) {
    if (!e.message?.includes('405')) {
      console.warn(`[EXCHANGE] setLeverage ${symbol}: ${e.message}`);
    }
  }
}

function calculateSize(balance, entryPrice, stopLoss) {
  const riskAmount = balance * (CONFIG.riskPercent / 100);
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance <= 0) return 0;
  const rawSize = (riskAmount / slDistance) * entryPrice;
  const leveragedSize = rawSize / entryPrice;
  return Math.round(leveragedSize * 1000) / 1000;
}

export async function openLong(symbol, entryPrice, stopLoss, takeProfit) {
  const ex = getExchange();
  if (!ex) return { success: false, error: 'API not configured' };
  const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
  try {
    await setLeverage(binanceSymbol);
    const balance = await getBalance();
    if (!balance || balance.free <= 0) return { success: false, error: 'No balance' };
    const size = calculateSize(balance.free, entryPrice, stopLoss || entryPrice * 0.99);
    if (size <= 0) return { success: false, error: 'Invalid size' };

    const order = await ex.createMarketBuyOrderWithCost(binanceSymbol, size * entryPrice);
    return { success: true, order, size, entryPrice };
  } catch (e) {
    console.error(`[EXCHANGE] openLong ${symbol} error:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function openShort(symbol, entryPrice, stopLoss, takeProfit) {
  const ex = getExchange();
  if (!ex) return { success: false, error: 'API not configured' };
  const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
  try {
    await setLeverage(binanceSymbol);
    const balance = await getBalance();
    if (!balance || balance.free <= 0) return { success: false, error: 'No balance' };
    const size = calculateSize(balance.free, entryPrice, stopLoss || entryPrice * 1.01);
    if (size <= 0) return { success: false, error: 'Invalid size' };

    const order = await ex.createMarketSellOrder(binanceSymbol, size);
    return { success: true, order, size, entryPrice };
  } catch (e) {
    console.error(`[EXCHANGE] openShort ${symbol} error:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function setStopLoss(symbol, side, size, stopPrice) {
  const ex = getExchange();
  if (!ex) return false;
  const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
  try {
    await ex.createOrder(binanceSymbol, 'STOP_MARKET', side === 'LONG' ? 'sell' : 'buy', size, null, { stopPrice });
    return true;
  } catch (e) {
    console.error(`[EXCHANGE] setStopLoss ${symbol} error:`, e.message);
    return false;
  }
}

export async function setTakeProfit(symbol, side, size, price) {
  const ex = getExchange();
  if (!ex) return false;
  const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
  try {
    await ex.createOrder(binanceSymbol, 'TAKE_PROFIT_MARKET', side === 'LONG' ? 'sell' : 'buy', size, null, { stopPrice: price });
    return true;
  } catch (e) {
    console.error(`[EXCHANGE] setTakeProfit ${symbol} error:`, e.message);
    return false;
  }
}

export async function closePosition(symbol) {
  const ex = getExchange();
  if (!ex) return { success: false, error: 'API not configured' };
  const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
  try {
    const pos = await getPosition(symbol);
    if (!pos) return { success: true, message: 'No position to close' };
    const side = pos.side === 'LONG' ? 'sell' : 'buy';
    const order = await ex.createMarketOrder(binanceSymbol, side, pos.size);
    return { success: true, order };
  } catch (e) {
    console.error(`[EXCHANGE] closePosition ${symbol} error:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function getCurrentPrice(symbol) {
  const ex = getExchange();
  if (!ex) return null;
  const binanceSymbol = SYMBOL_MAP[symbol] || symbol;
  try {
    const ticker = await ex.fetchTicker(binanceSymbol);
    return ticker.last;
  } catch (e) {
    console.error(`[EXCHANGE] getCurrentPrice ${symbol} error:`, e.message);
    return null;
  }
}
