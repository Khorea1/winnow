// Rotator all-in-one indexer – CLI args, config overrides, graceful shutdown.
// Priority: CLI flags > env vars > defaults.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/index.js';
import { registerDashboard } from './dashboard/index.js';
import { initDb } from './db/index.js';
import { EventLog } from './events.js';
import { HealthStore } from './health/index.js';
import { type ParsedProxy, parseLine } from './proxy/dial.js';
import { healthCheckTick } from './proxy/rotator.js';
import { createProxyServer } from './proxy/server.js';

// CLI argument parser (manual, replaces minimist)
function parseArgv(args: string[]) {
  const r: Record<string, string | number | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      r.help = true;
      continue;
    }
    const m = a.match(/^--(.+?)(?:=(.+))?$/);
    if (m) {
      const k = m[1].replace(/-/g, '');
      r[k] = m[2] ?? (i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : true);
      continue;
    }
    if (a.startsWith('-') && a.length === 2) {
      const ALIASES: Record<string, string> = { p: 'port', f: 'proxyfile', c: 'config', v: 'validationmode', t: 'timeout', d: 'datadir' };
      r[ALIASES[a[1]] ?? a[1]] = i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : true;
    }
  }
  return r;
}
const argv = parseArgv(process.argv.slice(2));

// Parse CLI args
// Parse CLI args — undefined when flag not passed, so config.json defaults survive
const cliPort = argv.port !== undefined ? Number(argv.port) : undefined;
const cliProxyFile = argv.proxyfile !== undefined ? (argv.proxyfile as string) : undefined;
const cliConfig = argv.config !== undefined ? (argv.config as string) : undefined;
const cliTimeout = argv.timeout !== undefined ? Number(argv.timeout) : undefined;
const cliValidationMode = (argv.validationmode as string | undefined) || process.env.WINNOW_VALIDATION_MODE || undefined;
const cliDataDir = (argv.datadir as string | undefined) || process.env.WINNOW_DATA_DIR || process.env.DATA_DIR || undefined;
// If --data-dir was passed, set env so config resolvers use it
if (cliDataDir?.trim()) {
  process.env.WINNOW_DATA_DIR = path.resolve(cliDataDir.trim());
}
// Set config path override if CLI config flag is present
if (cliConfig?.trim()) {
  process.env.WINNOW_CONFIG = path.resolve(cliConfig.trim());
}

// Load config (with CLI/Custom overrides)
const config = loadConfig();

// Apply CLI overrides to config (only when the flag was actually passed)
if (cliPort !== undefined) config.port = cliPort;
if (cliProxyFile !== undefined) config.proxyFile = cliProxyFile;
if (cliTimeout !== undefined) config.timeout = cliTimeout;
if (cliValidationMode !== undefined) config.validationMode = cliValidationMode as typeof config.validationMode;

// Derive DB path from proxy file path
const dbPath = `${path.resolve(config.proxyFile).replace(/\.[^.]+$/, '')}.db`;

// Initialize database
const db = initDb(dbPath);

// Event log
const eventLog = new EventLog();
const health = new HealthStore(db, config, eventLog);

// Proxy list
let proxies: ParsedProxy[] = [];

// Helper log function
const log = (...a: any[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// Load proxies
function load() {
  try {
    const list = fs
      .readFileSync(config.proxyFile, 'utf8')
      .split('\n')
      .map(parseLine)
      .filter((p): p is ParsedProxy => p !== null);
    const newSet = new Set(list.map((p) => p.raw));
    for (const k of health.keys()) if (!newSet.has(k)) health.delete(k);
    for (const p of list)
      if (!health.has(p.raw)) health.set(p.raw, { errors: 0, successes: 0, latency: 9999, bannedUntil: 0, lastOk: 0, fatalErrors: 0, frozenUntil: 0 });
    proxies = list;
    log(`[LOAD] ${proxies.length} proxies`);
  } catch (e: any) {
    log(`[WARN] Failed to load ${config.proxyFile}: ${e.message}`);
  }
}

const configRef = { current: config };
let shuttingDown = false;
let _hcInterval: ReturnType<typeof setInterval> | undefined;
let fileWatcher: fs.FSWatcher | undefined;
// Server initialization
const server = createProxyServer({
  config: configRef,
  health,
  eventLog,
  getProxies: () => proxies,
  onRequestMetrics: (_info) => {
    // optional: log metrics
    // console.log(`[METRICS] ${info.proxy} -> ${info.target} ${info.success ? 'OK' : 'FAIL'} ${info.bytes}b ${info.latency}ms`)
  },
});

// Dashboard registration
registerDashboard(server, { config: configRef, health, db, eventLog });
let hadUncaughtException = false;
// Graceful shutdown with timeout
function shutdown(reason = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[SHUTDOWN] ${reason} — flushing health...`);
  // Clear healthcheck interval — next tick sees shuttingDown and bails
  if (_hcInterval !== undefined) {
    clearInterval(_hcInterval);
    _hcInterval = undefined;
  }
  // Close file watcher
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch {}
    fileWatcher = undefined;
  }
  // Stop health store & db synchronously
  health.stop();
  db.close();
  // Close server (drains connections up to 10s)
  if (server) {
    server.close(() => log('[SHUTDOWN] server closed'));
  }
  // Hard exit after 10s if graceful close stalls
  // Use hadUncaughtException to signal non-zero exit
  setTimeout(() => process.exit(hadUncaughtException ? 1 : 0), 10_000).unref();
}
process.on('uncaughtException', (err) => {
  hadUncaughtException = true;
  console.error('[FATAL] Uncaught exception:', err);
  shutdown('uncaughtException');
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  // Log but don't shut down — unhandled rejections from non-critical paths
  // (e.g. health check timeouts) shouldn't crash the proxy.
  console.error('[WARN] Unhandled rejection:', reason);
});

let _hcRunning = false;
_hcInterval = setInterval(async () => {
  if (_hcRunning || shuttingDown) return;
  _hcRunning = true;
  try {
    await healthCheckTick(proxies, health, configRef.current, configRef.current.targets, eventLog);
  } finally {
    _hcRunning = false;
  }
}, 15000);
// Start server — wrap in error handling for EADDRINUSE etc.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`[FATAL] Port ${config.port} already in use — cannot bind`);
  } else {
    log(`[FATAL] Server error:`, err.message);
  }
  shutdown('server error');
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    process.exit(1);
  }
});
server.listen(config.port, '0.0.0.0', () => {
  log(
    `[START v1.0.0] :${config.port} | file=${config.proxyFile} | retries=${config.retries} | timeout=${config.timeout}ms | targets=${config.targets}\n[INFO] proxy -> http://127.0.0.1:${config.port} | dashboard http://127.0.0.1:${config.port}/dashboard`,
  );
});

// Initial load
load();
// Watch for file changes (inotify on Linux — instant vs polling)
// Debounce: fs.watch can fire multiple events for a single save
let _reloadTimer: NodeJS.Timeout | undefined;
try {
  fileWatcher = fs.watch(config.proxyFile, () => {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => load(), 300);
  });
} catch (e: any) {
  log(`[WARN] Could not watch proxy file: ${e.message}`);
}
