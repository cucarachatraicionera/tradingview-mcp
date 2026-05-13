/* Start everything from scratch:
   1. Kill old processes, clean DB
   2. Load indicator onto chart
   3. Start dashboard in background
   4. Start signals-bot in background
*/

import { execSync, spawn } from 'child_process';
import { unlinkSync, existsSync } from 'fs';
import { ensureIndicatorOnChart } from './load-indicator.js';

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

  // 3. Load indicator onto chart
  log('Loading Neural Matrix Pro onto chart...');
  try {
    const result = await ensureIndicatorOnChart({
      indicatorName: 'Neural Matrix Pro [Bot]',
      pinePath: `${ROOT}/strategies/neural_matrix_pro.pine`,
    });
    log(`Indicator: ${result.loaded ? 'OK' : 'FAIL'} (${result.method})`);
  } catch (e) {
    log(`Indicator ERROR: ${e.message}`);
  }

  // 4. Start dashboard
  log('Starting dashboard...');
  const dashboard = spawn('node', ['bot/dashboard/server.js'], {
    cwd: ROOT, stdio: 'ignore', detached: true
  });
  dashboard.unref();
  await sleep(2000);
  log(`Dashboard PID: ${dashboard.pid} (http://localhost:3456)`);

  // 5. Start bot
  log('Starting signals bot...');
  const bot = spawn('node', ['bot/signals-bot.js'], {
    cwd: ROOT, stdio: 'ignore', detached: true
  });
  bot.unref();
  await sleep(1000);
  log(`Bot PID: ${bot.pid}`);

  log('');
  log('═══════════════════════════════════');
  log('  Todo arrancado desde cero!');
  log('  Dashboard: http://localhost:3456');
  log('  Bot recogiendo señales...');
  log('═══════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
