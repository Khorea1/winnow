// Rotator all-in-one indexer – CLI args, config overrides, graceful shutdown.
// Priority: CLI flags > env vars > defaults.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveDataDir } from './config/index.js';
import { registerDashboard } from './dashboard/index.js';
import { initDb } from './db/index.js';
import { EventLog } from './events.js';
import { HealthStore } from './health/index.js';
import { createLogger } from './logger.js';
import { type ParsedProxy, parseLine } from './proxy/dial.js';
import { healthCheckTick } from './proxy/rotator.js';
import { createProxyServer } from './proxy/server.js';

// CLI argument parser (manual, replaces minimist)
function parseArgv(args: string[]): Record<string, string | number | boolean> {
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
const cliPort = typeof argv.port === 'string' ? Number(argv.port) : undefined;
const cliProxyFile = typeof argv.proxyfile === 'string' ? argv.proxyfile : undefined;
const cliConfig = typeof argv.config === 'string' ? argv.config : undefined;
const cliTimeout = typeof argv.timeout === 'string' ? Number(argv.timeout) : undefined;
const cliValidationMode = typeof argv.validationmode === 'string' ? argv.validationmode : process.env.WINNOW_VALIDATION_MODE || undefined;
const cliDataDir = typeof argv.datadir === 'string' ? argv.datadir : process.env.WINNOW_DATA_DIR || process.env.DATA_DIR || undefined;
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
if (cliProxyFile !== undefined) config.proxyFile = path.resolve(cliProxyFile);
if (cliTimeout !== undefined) config.timeout = cliTimeout;

const validModes = ['quick', 'standard', 'strict', 'stream', 'tcp-only'];
if (cliValidationMode !== undefined) {
  const mode = String(cliValidationMode).toLowerCase();
  if (validModes.includes(mode)) {
    config.validationMode = mode as typeof config.validationMode;
  } else {
    // Log a warning and fall back to the config.json / default instead of applying an invalid mode silently
    console.warn(`[CONFIG] Invalid validation mode '${cliValidationMode}' provided via CLI/env. Falling back to config.json.`);
  }
}

// Derive DB path from proxy file path
const parsed = path.parse(path.resolve(config.proxyFile));
const dbPath = path.join(parsed.dir, `${parsed.name}.db`);

// Initialize database
const db = initDb(dbPath);

// Event log
const eventLog = new EventLog();
const health = new HealthStore(db, config, eventLog);

// Proxy list
let proxies: ParsedProxy[] = [];

const logger = createLogger('main');

// Load proxies
function load() {
  if (_hcRunning) return;
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
    logger.info({ count: proxies.length }, 'loaded proxies');
  } catch (e: unknown) {
    logger.warn({ file: config.proxyFile, error: e instanceof Error ? e.message : String(e) }, 'failed to load proxy file');
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
  logger.info({ reason }, 'shutting down');
  clearTimeout(_reloadTimer);
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
  // Close server first — stop accepting new connections, drain in-flight
  if (server) {
    server.close(() => {
      health.stop();
      db.close();
      try {
        const pidPath = path.join(resolveDataDir(), '.winnow.pid');
        fs.unlinkSync(pidPath);
      } catch {}
      setTimeout(() => process.exit(hadUncaughtException ? 1 : 0), 10_000).unref();
    });
  } else {
    health.stop();
    db.close();
    try {
      const pidPath = path.join(resolveDataDir(), '.winnow.pid');
      fs.unlinkSync(pidPath);
    } catch {}
    setTimeout(() => process.exit(hadUncaughtException ? 1 : 0), 10_000).unref();
  }
}
process.on('uncaughtException', (err) => {
  hadUncaughtException = true;
  logger.error({ error: err.message, stack: err.stack }, 'uncaught exception');
  shutdown('uncaughtException');
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.warn({ error: String(reason) }, 'unhandled rejection');
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
    logger.error({ port: config.port }, 'port already in use');
  } else {
    logger.error({ error: err.message }, 'server error');
  }
  shutdown('server error');
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    process.exit(1);
  }
});
server.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port, file: config.proxyFile, retries: config.retries, timeout: config.timeout, targets: config.targets }, 'server started');
});
// Write PID file for graceful stop
try {
  const pidPath = path.join(resolveDataDir(), '.winnow.pid');
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
} catch {
  /* non-fatal */
}
// Initial load
load();
// Watch for file changes (inotify on Linux — instant vs polling)
// Debounce: fs.watch can fire multiple events for a single save
let _reloadTimer: NodeJS.Timeout | undefined;
const watchDir = path.dirname(path.resolve(config.proxyFile));
const watchFile = path.basename(config.proxyFile);
try {
  fileWatcher = fs.watch(watchDir, (eventType, filename) => {
    if (filename === watchFile) {
      clearTimeout(_reloadTimer);
      _reloadTimer = setTimeout(() => load(), 300);
    }
  });
} catch (e: unknown) {
  logger.warn({ dir: watchDir, error: e instanceof Error ? e.message : String(e) }, 'could not watch proxy directory');
}
