import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = resolve(__dirname, '../data');
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const db = new Database(resolve(dbDir, 'signals.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    tf            TEXT DEFAULT '',
    timestamp     INTEGER NOT NULL,
    signal_type   TEXT NOT NULL CHECK(signal_type IN ('LONG','SHORT')),
    entry_price   REAL NOT NULL,
    stop_loss     REAL NOT NULL,
    take_profit   REAL NOT NULL,
    rsi           REAL,
    atr           REAL,
    confidence    REAL,
    regime_score  REAL,
    news_headline TEXT,
    news_url      TEXT,
    news_sentiment TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','open','won','lost','closed')),
    exit_price    REAL,
    exit_time     INTEGER,
    pnl           REAL,
    pnl_percent   REAL,
    bars_to_exit  INTEGER,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
  CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
  CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
`);

// Migration: add columns if missing (safe to re-run)
try { db.exec(`ALTER TABLE signals ADD COLUMN confidence REAL`); } catch {}
try { db.exec(`ALTER TABLE signals ADD COLUMN regime_score REAL`); } catch {}
try { db.exec(`ALTER TABLE signals ADD COLUMN news_headline TEXT`); } catch {}
try { db.exec(`ALTER TABLE signals ADD COLUMN news_url TEXT`); } catch {}
try { db.exec(`ALTER TABLE signals ADD COLUMN news_sentiment TEXT`); } catch {}
try { db.exec(`ALTER TABLE signals ADD COLUMN tf TEXT DEFAULT ''`); } catch {}

export function insertSignal({ symbol, tf, signalType, entryPrice, stopLoss, takeProfit, rsi, atr, confidence, regimeScore, newsHeadline, newsUrl, newsSentiment }) {
  const stmt = db.prepare(`
    INSERT INTO signals (symbol, tf, timestamp, signal_type, entry_price, stop_loss, take_profit, rsi, atr, confidence, regime_score, news_headline, news_url, news_sentiment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(symbol, tf || '', Date.now(), signalType, entryPrice, stopLoss, takeProfit, rsi, atr, confidence, regimeScore, newsHeadline, newsUrl, newsSentiment);
  return result.lastInsertRowid;
}

export function getPendingSignals() {
  return db.prepare(`
    SELECT * FROM signals WHERE status IN ('pending','open')
    ORDER BY timestamp ASC
  `).all();
}

export function getAllSignals(limit = 100) {
  return db.prepare(`
    SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

export function getSignalsBySymbol(symbol, limit = 50) {
  return db.prepare(`
    SELECT * FROM signals WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?
  `).all(symbol, limit);
}

export function resolveSignal(id, { status, exitPrice, exitTime, pnl, pnlPercent, barsToExit }) {
  db.prepare(`
    UPDATE signals
    SET status = ?, exit_price = ?, exit_time = ?, pnl = ?, pnl_percent = ?, bars_to_exit = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, exitPrice, exitTime, pnl, pnlPercent, barsToExit, id);
}

export function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as count FROM signals`).get();
  const won = db.prepare(`SELECT COUNT(*) as count FROM signals WHERE status = 'won'`).get();
  const lost = db.prepare(`SELECT COUNT(*) as count FROM signals WHERE status = 'lost'`).get();
  const pending = db.prepare(`SELECT COUNT(*) as count FROM signals WHERE status IN ('pending','open')`).get();
  const totalPnl = db.prepare(`SELECT COALESCE(SUM(pnl), 0) as pnl FROM signals WHERE status IN ('won','lost')`).get();
  const bySymbol = db.prepare(`
    SELECT symbol,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
           SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost,
           COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN pnl ELSE 0 END), 0) as pnl
    FROM signals
    GROUP BY symbol
    ORDER BY pnl DESC
  `).all();
  const byCombo = db.prepare(`
    SELECT symbol, tf,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
           SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost,
           COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN pnl ELSE 0 END), 0) as pnl
    FROM signals
    GROUP BY symbol, tf
    ORDER BY pnl DESC
  `).all();
  const recent = db.prepare(`SELECT * FROM signals ORDER BY timestamp DESC LIMIT 20`).all();
  const equityCurve = db.prepare(`
    SELECT timestamp, pnl FROM signals
    WHERE status IN ('won','lost') AND pnl IS NOT NULL
    ORDER BY timestamp ASC
  `).all();

  const totalCount = total.count || 0;
  const resolvedCount = (won.count || 0) + (lost.count || 0);

  return {
    total: totalCount,
    won: won.count || 0,
    lost: lost.count || 0,
    pending: pending.count || 0,
    winRate: resolvedCount > 0 ? (((won.count || 0) / resolvedCount) * 100).toFixed(1) : 0,
    totalPnl: (totalPnl.pnl || 0).toFixed(2),
    bySymbol,
    byCombo,
    recent,
    equityCurve: computeCumulativeEquity(equityCurve),
  };
}

function computeCumulativeEquity(rows) {
  let cum = 0;
  return rows.map(r => {
    cum += (r.pnl || 0);
    return { timestamp: r.timestamp, equity: Math.round(cum * 100) / 100 };
  });
}

export function getRLData() {
  return db.prepare(`
    SELECT signal_type, entry_price, stop_loss, take_profit, rsi, atr, status, pnl, pnl_percent, bars_to_exit, symbol
    FROM signals WHERE status IN ('won','lost')
    ORDER BY timestamp DESC
  `).all();
}

export default db;
