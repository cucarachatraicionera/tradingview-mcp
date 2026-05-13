import express from 'express';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import * as db from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3456;

app.use(express.static(resolve(__dirname, 'public')));

app.get('/api/stats', (req, res) => {
  try {
    res.json(db.getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/signals', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const symbol = req.query.symbol;
    const data = symbol ? db.getSignalsBySymbol(symbol, limit) : db.getAllSignals(limit);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rl-data', (req, res) => {
  try {
    res.json(db.getRLData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});
