// Rotator all-in-one indexer – CLI args, config overrides, graceful shutdown.
// Priority: CLI flags > env vars > defaults.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveDataDir } from './config/index.js';
import { registerDashboard } from './dashboard/index.js';
import { initDb, startIncrementalVacuum } from './db/index.js';
import { EventLog } from './events.js';
import { blankEntry, HealthStore } from './health/index.js';
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
    const m = a.match(/^--(.+?)(?:=(.*))?$/);
    if (m) {
      const k = m[1].replace(/-/g, '');
      r[k] = m[2] ?? (i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : true);
      continue;
    }
    if (a.startsWith('-') && a.length === 2) {
      const ALIASES: Record<string, string> = { p: 'port', f: 'proxyfile', c: 'config', v: 'validationmode', t: 'timeout', d: 'datadir' };
      const alias = ALIASES[a[1]];
      if (!alias) {
        console.warn(`Unknown flag: ${a}`);
        continue;
      }
      r[alias] = i + 1 < args.length && !args[i + 1].startsWith('-') ? args[++i] : true;
    }
  }
  return r;
}
const argv = parseArgv(process.argv.slice(2));
if (argv.help === true) {
  console.log(
    `Usage: winnow [options]\n\nOptions:\n  -h, --help                 Show this help and exit\n  -p, --port <port>          Listen port (1–65535)\n  -f, --proxy-file <path>    Proxy list file\n  -c, --config <path>        Config file path\n  -t, --timeout <ms>         Upstream timeout (500–60000)\n  -v, --validation-mode <m>  quick, standard, strict, stream, tcp-only\n  -d, --data-dir <path>      Data directory`,
  );
  process.exit(0);
}

// Parse CLI args — undefined when flag not passed, so config.json defaults survive
const cliPort = typeof argv.port === 'string' ? Number(argv.port) : undefined;
const cliProxyFile = typeof argv.proxyfile === 'string' ? argv.proxyfile : undefined;
const cliConfig = typeof argv.config === 'string' ? argv.config : undefined;
const cliTimeout = typeof argv.timeout === 'string' ? Number(argv.timeout) : undefined;
if (cliPort !== undefined && !Number.isFinite(cliPort)) {
  console.error('Invalid --port value');
  process.exit(1);
}
if (cliTimeout !== undefined && !Number.isFinite(cliTimeout)) {
  console.error('Invalid --timeout value');
  process.exit(1);
}
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
if (cliPort !== undefined) {
  if (cliPort >= 1 && cliPort <= 65535) {
    config.port = cliPort;
  } else {
    console.error(`Invalid --port value ${cliPort}, using config value ${config.port}`);
  }
}
if (cliProxyFile !== undefined) {
  if (!cliProxyFile.includes('\0')) {
    config.proxyFile = path.resolve(cliProxyFile);
  } else {
    console.error('Invalid --proxy-file value contains null byte, using config value');
  }
}
if (cliTimeout !== undefined) {
  if (cliTimeout >= 500 && cliTimeout <= 60000) {
    config.timeout = cliTimeout;
  } else {
    console.error(`Invalid --timeout value ${cliTimeout}, using config value ${config.timeout}`);
  }
}

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
const stopIncrementalVacuum = startIncrementalVacuum(db);

// Event log
const eventLog = new EventLog();
const health = new HealthStore(db, config, eventLog);
const requestMetrics = { requests: 0, successes: 0, failures: 0, bytes: 0, latencyMs: 0 };
const MAX_METRIC = Number.MAX_SAFE_INTEGER;
function recordRequestMetrics(info: { success: boolean; latency: number; bytes: number }) {
  requestMetrics.requests = Math.min(MAX_METRIC, requestMetrics.requests + 1);
  if (info.success) requestMetrics.successes = Math.min(MAX_METRIC, requestMetrics.successes + 1);
  else requestMetrics.failures = Math.min(MAX_METRIC, requestMetrics.failures + 1);
  requestMetrics.bytes = Math.min(MAX_METRIC, requestMetrics.bytes + Math.max(0, info.bytes));
  requestMetrics.latencyMs = Math.min(MAX_METRIC, requestMetrics.latencyMs + Math.max(0, info.latency));
}

// Proxy list
let proxies: ParsedProxy[] = [];

const logger = createLogger('main');

// Load proxies
function load() {
  if (shuttingDown) return;
  if (_hcRunning) {
    _pendingReload = true;
    return;
  }
  _pendingReload = false;
  let list: ParsedProxy[];
  try {
    const content = fs.readFileSync(config.proxyFile, 'utf8');
    const seen = new Set<string>();
    list = content
      .split('\n')
      .map(parseLine)
      .filter((p): p is ParsedProxy => {
        if (!p || seen.has(p.raw)) return false;
        seen.add(p.raw);
        return true;
      });
  } catch (e: unknown) {
    logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'failed to read proxy file');
    return;
  }
  try {
    const newSet = new Set(list.map((p) => p.raw));
    for (const k of health.keys()) if (!newSet.has(k)) health.delete(k);
    for (const p of list) if (!health.has(p.raw)) health.set(p.raw, blankEntry());
    proxies = list;
    logger.info({ count: proxies.length }, 'loaded proxies');
  } catch (e: unknown) {
    logger.error({ error: e instanceof Error ? e.message : String(e) }, 'failed to sync health');
    return;
  }
}

const configRef = { current: config };
let shuttingDown = false;
let _hcTimer: ReturnType<typeof setTimeout> | undefined;
let fileWatcher: fs.FSWatcher | undefined;
// Server initialization
const server = createProxyServer({
  config: configRef,
  health,
  eventLog,
  getProxies: () => proxies,
  onRequestMetrics: recordRequestMetrics,
});

// Dashboard registration — onConfigChange reschedules health check timer on hot-reload
registerDashboard(server, {
  config: configRef,
  health,
  db,
  eventLog,
  getRequestMetrics: () => ({ ...requestMetrics }),
  onConfigChange: () => {
    clearTimeout(_hcTimer);
    _hcTimer = undefined;
    // If a tick is running, the running tick's final call to scheduleNextHealthCheck()
    // picks up the new interval from configRef.current automatically.
    // If nothing is running, schedule now with the new interval.
    if (!_hcRunning) scheduleNextHealthCheck();
  },
});
let hadUncaughtException = false;
// Graceful shutdown with timeout
function shutdown(reason = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');
  clearTimeout(_reloadTimer);
  // Clear healthcheck timer — next tick sees shuttingDown and bails
  if (_hcTimer !== undefined) {
    clearTimeout(_hcTimer);
    _hcTimer = undefined;
  }
  // Close file watcher
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch {}
    fileWatcher = undefined;
  }
  stopIncrementalVacuum();
  // Two-phase shutdown: stop accepting → drain 5s → force-close → force-exit 10s
  // Phase 1: server.close() stops accepting new connections, lets in-flight drain.
  // Phase 2 (5s): closeAllConnections() forcibly closes remaining tunnels/requests.
  // Phase 3 (10s): force exit as last resort, flushing health first (F5 fix).
  if (server) {
    const forceExit = setTimeout(() => {
      // Last-resort exit — flush health before dying so no data is lost (F5 fix)
      try {
        health.stop();
        stopIncrementalVacuum();
        db.close();
      } catch {}
      try {
        const pidPath = path.join(resolveDataDir(), '.winnow.pid');
        fs.unlinkSync(pidPath);
      } catch {}
      process.exit(hadUncaughtException ? 1 : 0);
    }, 10_000).unref();

    // After 5s, forcibly close all remaining connections (F4 fix)
    const drainTimeout = setTimeout(() => {
      logger.info({}, 'forcing connection close after drain timeout');
      server.closeAllConnections();
    }, 5_000).unref();

    server.close(() => {
      clearTimeout(forceExit);
      clearTimeout(drainTimeout);
      health.stop();
      stopIncrementalVacuum();
      db.close();
      try {
        const pidPath = path.join(resolveDataDir(), '.winnow.pid');
        fs.unlinkSync(pidPath);
      } catch {}
      process.exit(hadUncaughtException ? 1 : 0);
    });
  }
}
process.on('uncaughtException', (err) => {
  hadUncaughtException = true;
  logger.error({ error: err.message, stack: err.stack }, 'uncaught exception');
  // Flush health store synchronously, then exit quickly
  health.stop(); // flushes pending writes
  stopIncrementalVacuum();
  db.close();
  try {
    const pidPath = path.join(resolveDataDir(), '.winnow.pid');
    fs.unlinkSync(pidPath);
  } catch {}
  process.exit(1);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  hadUncaughtException = true;
  const ctx: Record<string, unknown> = {};
  if (reason instanceof Error) {
    ctx.error = reason.message;
    ctx.stack = reason.stack;
  } else {
    ctx.error = String(reason);
  }
  logger.warn(ctx, 'unhandled rejection');
  shutdown('unhandledRejection');
});
let _hcRunning = false;
let _pendingReload = false;
async function scheduleNextHealthCheck() {
  if (shuttingDown) return;
  // When disabled, poll every 5s to detect re-enable. When enabled, use configured interval.
  const interval = configRef.current.healthCheckInterval;
  const ms = interval === false ? 5000 : typeof interval === 'number' && interval > 0 ? interval : 15000;
  _hcTimer = setTimeout(async () => {
    if (shuttingDown) return;
    // Read interval fresh from config — picks up hot-reload changes
    if (!_hcRunning && configRef.current.healthCheckInterval !== false) {
      _hcRunning = true;
      try {
        await healthCheckTick(proxies, health, configRef.current, configRef.current.targets, eventLog);
      } finally {
        _hcRunning = false;
        if (_pendingReload) {
          _pendingReload = false;
          load();
        }
      }
    }
    scheduleNextHealthCheck(); // Always re-schedule (unless shuttingDown) — picks up new config interval
  }, ms);
  _hcTimer.unref();
}
scheduleNextHealthCheck();
// Start server — wrap in error handling for EADDRINUSE etc.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error({ port: config.port }, 'address already in use');
  } else {
    logger.error({ error: err.message }, 'server error');
  }
  shutdown('server_error');
});
try {
  const pidPath = path.join(resolveDataDir(), '.winnow.pid');
  const fd = fs.openSync(pidPath, 'wx');
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
} catch (e: unknown) {
  if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
    try {
      const existingPid = fs.readFileSync(path.join(resolveDataDir(), '.winnow.pid'), 'utf8').trim();
      const pid = Number(existingPid);
      let stale = !Number.isSafeInteger(pid) || pid <= 0;
      if (!stale) {
        try {
          process.kill(pid, 0);
          console.error('Another instance already running (PID ' + existingPid + '). Exiting.');
          process.exit(1);
        } catch (killError: unknown) {
          const code = (killError as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') stale = true;
          else if (code === 'EPERM') {
            console.error('Another instance is active or inaccessible (PID ' + existingPid + '). Exiting.');
            process.exit(1);
          } else throw killError;
        }
      }
      if (stale) fs.writeFileSync(path.join(resolveDataDir(), '.winnow.pid'), String(process.pid), 'utf8');
    } catch (checkError) {
      if ((checkError as NodeJS.ErrnoException).code === 'EPERM') console.error('PID file is inaccessible; refusing to overwrite it.');
    }
  }
}
// Initial load
load();
// Start server — wrap in error handling for EADDRINUSE etc.
server.listen(config.port, '0.0.0.0', () => {
  logger.info({ port: config.port, file: config.proxyFile, retries: config.retries, timeout: config.timeout, targets: config.targets }, 'server started');
});
// Watch for file changes (inotify on Linux — instant vs polling)
// Debounce: fs.watch can fire multiple events for a single save
let _reloadTimer: NodeJS.Timeout | undefined;
const watchDir = path.dirname(path.resolve(config.proxyFile));
const watchFile = path.basename(config.proxyFile);
let _lastMtime = 0;
function setupWatcher() {
  if (shuttingDown) return;
  try {
    fileWatcher?.close();
  } catch {}
  fileWatcher = undefined;
  try {
    const watcher = fs.watch(watchDir, (_eventType, filename) => {
      if (filename === watchFile || filename === null) {
        clearTimeout(_reloadTimer);
        _reloadTimer = setTimeout(() => load(), 300);
      } else {
        try {
          const mtime = fs.statSync(config.proxyFile).mtimeMs;
          if (mtime > _lastMtime) {
            _lastMtime = mtime;
            clearTimeout(_reloadTimer);
            _reloadTimer = setTimeout(() => load(), 300);
          }
        } catch {}
      }
    });
    // Runtime watcher errors (inotify instance/dir limits, watched dir
    // deleted) are emitted as 'error' events — without a handler they throw
    // and kill the process. Log, drop the dead watcher, retry with backoff.
    watcher.on('error', (err: Error) => {
      logger.warn({ dir: watchDir, error: err.message }, 'proxy file watcher error — hot-reload paused, retrying');
      try {
        watcher.close();
      } catch {}
      if (fileWatcher === watcher) fileWatcher = undefined;
      if (!shuttingDown) setTimeout(setupWatcher, 5000).unref();
    });
    fileWatcher = watcher;
  } catch (e: unknown) {
    logger.warn({ dir: watchDir, error: e instanceof Error ? e.message : String(e) }, 'could not watch proxy directory');
  }
}
setupWatcher();
