import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { type RotatorConfig, resolveDataDir, updateConfig } from '../config/index.js';
import { createValidationRun, finishValidationRun } from '../db/index.js';
import { EventLog, type ProxyEvent } from '../events.js';
import { type HealthEntry, HealthStore } from '../health/index.js';
import { createLogger } from '../logger.js';
import { parseLine } from '../proxy/dial.js';
import { buildOptionsFromConfig } from '../validator/index.js';
import { runValidation } from '../validator/runner.js';
import type { ProxyResult } from '../validator/types.js';

let _validationRunning = false;
const logger = createLogger('dashboard');
let _abortController: AbortController | null = null;

const _DASHBOARD_PATH = path.join(import.meta.dirname, '../../public/dashboard.html');
let _dashboardHtml: string | null = null;
const MAX_BODY_SIZE = 32 * 1024;
interface ValidationOverrides {
  threads?: number;
  mode?: 'quick' | 'standard' | 'strict' | 'stream' | 'tcp-only';
  baseUrl?: string;
  maxLatency?: number;
  connectTimeout?: number;
  throttle?: number;
  ttfbRatio?: number;
  maxGap?: number;
  insecure?: boolean;
  strictTLS?: boolean;
  anonCheck?: boolean;
  tlsHost?: string;
  tlsPort?: number;
  prune?: boolean;
}
const MAX_SSE_CLIENTS = 100;

function getAuthToken() {
  return process.env.WINNOW_TOKEN || process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || null;
}
function isAuthorized(req: IncomingMessage) {
  const token = getAuthToken();
  if (!token) {
    // In production, fail-closed: block API routes when no token is configured.
    // This prevents accidental exposure of the dashboard API on a public port.
    return false; // Production without token: block all dashboard/API/events access
  }
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return true;
  if (auth === token) return true;
  return false;
}
function isSafeProxyFile(p: string, allowedDir: string): boolean {
  if (typeof p !== 'string' || !p) return false;
  if (p.includes('\0')) return false;
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(allowedDir, p);
    // Resolve symlinks on the file itself, not just the directory — prevents
    // path traversal via a symlink pointing outside the allowed directory.
    const realFile = fs.realpathSync(abs);
    const realAllowedDir = fs.realpathSync(allowedDir);
    return realFile === realAllowedDir || realFile.startsWith(realAllowedDir + path.sep);
  } catch {
    return false;
  }
}
function sanitizeProxyKey(key: string): string {
  try {
    const u = new URL(key);
    u.username = '';
    u.password = '';
    // URL class adds trailing slash, remove it; also strip protocol prefix for consistent comparison
    return u
      .toString()
      .replace(/\/$/, '')
      .replace(/^[a-z]+:\/\//, '');
  } catch {
    // URL parsing failed — likely protocol-less string with credentials
    // Strip user:password@ prefix if present
    return key.replace(/^.*@/, '');
  }
}

function respondJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Read request body with size limit. Returns null and sends 413 if too large. */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  req.on('data', (c: Buffer) => {
    if (tooLarge) return;
    chunks.push(c);
    totalBytes += c.length;
    if (totalBytes > MAX_BODY_SIZE) {
      tooLarge = true;
      try {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Body too large - max ${MAX_BODY_SIZE}` }));
      } catch {}
      req.resume();
      resolve(null); // Resolve immediately to prevent dangling promises
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    const body = Buffer.concat(chunks).toString('utf8');
    resolve(body);
  });
  // Prevent hanging promise if the client disconnects mid-request
  req.on('error', () => resolve(null));
  req.on('close', () => resolve(null));
  return promise;
}

function serveDashboard(res: ServerResponse) {
  try {
    if (!_dashboardHtml) {
      const candidates = [_DASHBOARD_PATH, path.join(process.cwd(), 'public/dashboard.html')];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          _dashboardHtml = fs.readFileSync(c, 'utf8');
          break;
        }
      }
      if (!_dashboardHtml) {
        // fallback minimal
        _dashboardHtml = '<html><body><h1>Dashboard not found</h1></body></html>';
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'",
    });
    res.end(_dashboardHtml);
  } catch (e: unknown) {
    res.writeHead(500);
    res.end(`Dashboard error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function broadcast(clients: Set<ServerResponse>, event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: ServerResponse[] = [];
  const MAX_BUFFER = 64 * 1024; // 64KB per client
  for (const res of clients) {
    try {
      if (res.writableLength > MAX_BUFFER) {
        dead.push(res);
        continue;
      }
      res.write(msg);
    } catch {
      dead.push(res);
    }
  }
  for (const d of dead) clients.delete(d);
}
export function registerDashboard(
  server: http.Server,
  ctx: { config: { current: RotatorConfig }; health: HealthStore; db: Database.Database; eventLog?: EventLog },
) {
  const { config: cfgRef, health, db, eventLog } = ctx;
  const sseClients = new Set<ServerResponse>();

  health.on('health:update', (data: unknown) => {
    broadcast(sseClients, 'health:update', data);
  });

  // LOG: subscribe to event log for live SSE broadcasting
  const eventSubscriber = (e: ProxyEvent) => broadcast(sseClients, 'proxy:event', e);
  eventLog?.subscribe(eventSubscriber);

  // LOG: periodic pool status events
  const poolInterval = setInterval(() => {
    try {
      const now = Date.now();
      const aliveCount = [...health.entries()].filter(([_raw, h]: [string, HealthEntry]) => {
        if (h.frozenUntil > now || now < h.bannedUntil || h.errors >= (cfgRef.current.maxErrors ?? 3)) return false;
        return true;
      }).length;
      EventLog.safePush(eventLog, {
        type: 'pool',
        proxy: '',
        target: '',
        status: 'info',
        detail: `total=${health.size}, alive=${aliveCount}`,
      });
    } catch {}
  }, 30000);
  poolInterval.unref();

  const origListeners = server.listeners('request');
  server.removeAllListeners('request');

  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlObj = new URL(req.url || '/', 'http://localhost');
      const pathname = urlObj.pathname;
      const needsAuth = pathname.startsWith('/api/') || pathname === '/dashboard' || pathname === '/events' || pathname === '/__stats';

      if (needsAuth && !isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (pathname === '/') {
        res.writeHead(302, { Location: '/dashboard' });
        res.end();
        return;
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        respondJson(res, cfgRef.current);
        return;
      }

      if (pathname === '/api/events/log' && req.method === 'GET') {
        const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
        respondJson(res, { events: eventLog?.recent(limit) || [] });
        return;
      }
      if (pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req, res);
        if (body === null) return;
        try {
          const patch = JSON.parse(body);
          const updated = updateConfig(patch);
          Object.assign(cfgRef.current, updated);
          // Refresh server-level timeouts from current config
          if (typeof updated.timeout === 'number') {
            server.timeout = Math.max(updated.timeout, 5000);
            server.keepAliveTimeout = Math.min(server.timeout, 30000);
          }
          respondJson(res, updated);
        } catch (e: unknown) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }

      if (pathname === '/api/proxy' && req.method === 'DELETE') {
        const key = urlObj.searchParams.get('key');
        if (!key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing key parameter' }));
          return;
        }
        const proxyFile = cfgRef.current.proxyFile;
        if (!isSafeProxyFile(proxyFile, resolveDataDir())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsafe proxyFile' }));
          return;
        }
        try {
          let removedFromFile = false;
          if (fs.existsSync(proxyFile)) {
            const lines = fs.readFileSync(proxyFile, 'utf8').split('\n');
            const kept = lines.filter((line) => {
              const parsed = parseLine(line);
              if (!parsed) return true; // keep comments/blank/unparsable lines untouched
              if (sanitizeProxyKey(parsed.raw) === sanitizeProxyKey(key)) {
                removedFromFile = true;
                return false;
              }
              return true;
            });
            if (removedFromFile) {
              const dir = path.dirname(path.resolve(proxyFile));
              const tmpFile = path.join(dir, `.${path.basename(proxyFile)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
              fs.writeFileSync(tmpFile, kept.join('\n'), 'utf8');
              fs.renameSync(tmpFile, proxyFile);
            }
          }
          let removedFromHealth = false;
          for (const [raw] of health.entries()) {
            if (sanitizeProxyKey(raw) === sanitizeProxyKey(key)) {
              health.delete(raw);
              removedFromHealth = true;
            }
          }
          if (!removedFromFile && !removedFromHealth) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy not found' }));
            return;
          }
          EventLog.safePush(eventLog, { type: 'pool', proxy: key, target: '', status: 'info', detail: 'removed via dashboard' });
          broadcast(sseClients, 'proxy:removed', { key });
          respondJson(res, { removed: true, key, removedFromFile, removedFromHealth });
        } catch (e: unknown) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
        return;
      }

      if (pathname === '/events') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many SSE clients' }));
          return;
        }
        const corsOrigin = process.env.WINNOW_CORS_ORIGIN;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        sseClients.add(res);
        const cleanup = () => {
          sseClients.delete(res);
          clearInterval(hb);
        };
        req.on('close', cleanup);
        const hb = setInterval(() => {
          try {
            res.write(':heartbeat\n\n');
          } catch {
            cleanup();
          }
        }, 30000);
        hb.unref();
        return;
      }
      if (pathname === '/api/validate' && req.method === 'POST') {
        const body = await readBody(req, res);
        if (body === null) return;
        let custom: Partial<ValidationOverrides> = {};
        if (body.trim()) {
          try {
            custom = JSON.parse(body);
          } catch {
            custom = {};
          }
        }
        if (typeof custom.threads === 'number') custom.threads = Math.max(1, Math.min(100, Math.floor(custom.threads)));
        if (typeof custom.connectTimeout === 'number') custom.connectTimeout = Math.max(1, Math.min(60, Math.floor(custom.connectTimeout)));
        if (typeof custom.maxLatency === 'number') custom.maxLatency = Math.max(100, Math.min(60000, custom.maxLatency));
        if (typeof custom.throttle === 'number') custom.throttle = Math.max(0, Math.min(10000, custom.throttle));
        if (typeof custom.ttfbRatio === 'number') custom.ttfbRatio = Math.max(0, Math.min(1000, custom.ttfbRatio));
        if (typeof custom.maxGap === 'number') custom.maxGap = Math.max(0, Math.min(60000, custom.maxGap));
        if (custom.tlsPort !== undefined) custom.tlsPort = Math.max(1, Math.min(65535, Math.floor(custom.tlsPort)));
        if (custom.mode !== undefined && !['quick', 'standard', 'strict', 'stream', 'tcp-only'].includes(custom.mode)) {
          delete custom.mode;
        }
        startValidation(res, { cfgRef, sseClients, health, db, custom }).catch((err) => {
          logger.error({ error: err instanceof Error ? err.message : String(err) }, 'validation failed to start');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Validation failed to start' }));
          }
        });
        return;
      }

      if (pathname === '/dashboard') {
        serveDashboard(res);
        return;
      }

      if (pathname === '/api/validate' && req.method === 'GET') {
        try {
          const rows = db.prepare('SELECT * FROM validation_runs ORDER BY id DESC LIMIT 20').all();
          respondJson(res, rows);
        } catch (e: unknown) {
          respondJson(res, { error: e instanceof Error ? e.message : String(e) }, 500);
        }
        return;
      }

      if (pathname === '/api/validate/status' && req.method === 'GET') {
        respondJson(res, { running: _validationRunning });
        return;
      }

      if (pathname === '/api/validate/stop' && req.method === 'POST') {
        if (_abortController && _validationRunning) {
          _abortController.abort();
          broadcast(sseClients, 'validation:stopping', { stopping: true });
          respondJson(res, { stopped: true });
        } else {
          respondJson(res, { stopped: false, reason: 'not running' });
        }
        return;
      }

      if (pathname === '/__stats') {
        const now = Date.now();
        const maxErrors = cfgRef.current.maxErrors ?? 3;
        const list = [...health.entries()]
          .map(([raw, h]: [string, HealthEntry]) => {
            const frozen = h.frozenUntil > now;
            const banned = now < h.bannedUntil;
            const score = frozen || banned ? Infinity : HealthStore.computeScore(h, now);
            return { proxy: sanitizeProxyKey(raw), ...h, score, banned, frozen };
          })
          .sort((a, b) => a.score - b.score)
          .slice(0, 50);
        const alive = [...health.entries()].filter(([_raw, h]: [string, HealthEntry]) => {
          if (h.frozenUntil > now || now < h.bannedUntil || h.errors >= maxErrors) return false;
          return true;
        }).length;
        respondJson(res, {
          total: health.size,
          alive,
          top: list,
          targets: cfgRef.current.targets,
          retries: cfgRef.current.retries,
          timeout: cfgRef.current.timeout,
        });
        return;
      }

      // Not a dashboard route — delegate to original listeners (HTTP proxy handler)
      for (const listener of origListeners) {
        try {
          listener(req, res);
        } catch (err) {
          logger.error({ error: err instanceof Error ? err.message : String(err) }, 'original request listener error');
          // Don't break — let remaining listeners execute
          // Don't send a 500 — the failed listener may have already written headers
        }
      }
    } catch (e: unknown) {
      try {
        respondJson(res, { error: e instanceof Error ? e.message : String(e) }, 500);
      } catch {}
    }
  });
}

async function startValidation(
  res: ServerResponse,
  ctx: {
    cfgRef: { current: RotatorConfig };
    sseClients: Set<ServerResponse>;
    health: HealthStore;
    db: Database.Database;
    custom: Partial<ValidationOverrides>;
  },
) {
  if (_validationRunning) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Validation already running' }));
    return;
  }

  const cfg = ctx.cfgRef.current;
  const proxyFile = cfg.proxyFile;

  if (!isSafeProxyFile(proxyFile, resolveDataDir())) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unsafe proxyFile' }));
    return;
  }

  if (!fs.existsSync(proxyFile)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy file not found' }));
    return;
  }

  const custom = ctx.custom || {};
  const opts = buildOptionsFromConfig(cfg, {
    threads: custom.threads ?? cfg.validationThreads,
    mode: custom.mode ?? cfg.validationMode,
    baseUrl: custom.baseUrl ?? cfg.validationBaseUrl,
    maxLatency: custom.maxLatency ?? cfg.validationMaxLatency,
    connectTimeout: custom.connectTimeout ?? cfg.validationConnectTimeout,
    throttle: custom.throttle ?? cfg.validationThrottle,
    ttfbRatio: custom.ttfbRatio ?? cfg.validationTtfbRatio,
    insecure: custom.insecure ?? cfg.validationInsecure,
    strictTLS: custom.strictTLS ?? cfg.validationStrictTLS,
    anonCheck: custom.anonCheck ?? cfg.validationAnonCheck,
    tlsHost: custom.tlsHost ?? cfg.validationTlsHost,
    tlsPort: custom.tlsPort ?? cfg.validationTlsPort,
    maxGap: custom.maxGap ?? cfg.validationMaxGap,
  });

  const runId = createValidationRun(ctx.db);
  _validationRunning = true;
  _abortController = new AbortController();

  respondJson(res, { jobId: runId, mode: opts.mode, threads: opts.threads, started: Date.now() });

  broadcast(ctx.sseClients, 'validation:start', { jobId: runId, mode: opts.mode, threads: opts.threads });

  try {
    const content = await fs.promises.readFile(proxyFile, 'utf8');
    const proxies = content
      .split('\n')
      .map((l: string) => l.trim())
      .filter(Boolean)
      .filter((l: string) => !l.startsWith('#'));
    const uniq = Array.from(new Set(proxies));

    let validCount = 0;
    let invalidCount = 0;

    const onProgress = (result: ProxyResult, stats: { total: number; done: number; valid: number; invalid: number }) => {
      const now = Date.now();
      if (result.valid) {
        const latency = result.latency || 300;
        ctx.health.recordSuccess(result.proxy, undefined, latency, now);
      } else {
        const err = new Error(result.error || 'validation failed');
        ctx.health.recordFailure(result.proxy, undefined, err, ctx.cfgRef.current, now);
      }

      const line = result.valid
        ? `[VALID] ${result.proxy} (${result.stage})`
        : `[INVALID] ${result.proxy} - ${result.error || 'error'} (${result.stage || '?'})`;

      broadcast(ctx.sseClients, 'validation:progress', {
        jobId: runId,
        proxy: result.proxy,
        valid: result.valid,
        error: result.error,
        stage: result.stage,
        done: stats.done,
        total: stats.total,
        validCount: stats.valid,
        invalidCount: stats.invalid,
        line,
      });
    };

    const result = await runValidation(uniq, opts, onProgress, _abortController.signal);

    validCount = result.valid.length;
    invalidCount = result.invalid.length;

    // Prune ou append
    try {
      const prune = custom.prune ?? cfg.validationPrune;
      if (prune) {
        if (result.valid.length > 0) {
          const dir = path.dirname(path.resolve(proxyFile));
          const tmpFile = path.join(dir, `.${path.basename(proxyFile)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
          fs.writeFileSync(tmpFile, `${result.valid.join('\n')}\n`, 'utf8');
          fs.renameSync(tmpFile, proxyFile);
          logger.info({ kept: result.valid.length, removed: result.invalid.length }, 'pruned proxy file');
        } else {
          logger.info({}, 'no valid proxies, keeping original file');
        }
      } else {
        const existing = new Set<string>();
        let existingContent = '';
        try {
          existingContent = fs.readFileSync(proxyFile, 'utf8');
          for (const line of existingContent.split('\n')) {
            const t = line.trim();
            if (t) existing.add(t);
          }
        } catch {}
        const newProxies = result.valid.filter((p) => !existing.has(p));
        if (newProxies.length) {
          const dir = path.dirname(path.resolve(proxyFile));
          const tmpFile = path.join(dir, `.${path.basename(proxyFile)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
          const finalContent = `${(existingContent ? existingContent.replace(/\n*$/, '\n') : '') + newProxies.join('\n')}\n`;
          fs.writeFileSync(tmpFile, finalContent, 'utf8');
          fs.renameSync(tmpFile, proxyFile);
          logger.info({ count: newProxies.length }, 'auto-imported new proxies');
        }
      }
    } catch (e: unknown) {
      logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'file update error');
    }
    // Clean up health entries for invalid proxies
    for (const p of result.invalid) {
      ctx.health.delete(p.proxy);
    }

    finishValidationRun(ctx.db, runId, uniq.length, validCount, invalidCount, 0);
    broadcast(ctx.sseClients, 'validation:complete', { jobId: runId, exitCode: 0, total: uniq.length, passed: validCount, failed: invalidCount });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg === 'aborted' || _abortController?.signal.aborted) {
      logger.info({}, 'validation aborted by user');
      finishValidationRun(ctx.db, runId, 0, 0, 0, 130);
      broadcast(ctx.sseClients, 'validation:complete', { jobId: runId, exitCode: 130, total: 0, passed: 0, failed: 0, stopped: true });
    } else {
      logger.warn({ error: errMsg }, 'validation error');
      finishValidationRun(ctx.db, runId, 0, 0, 0, 1);
      broadcast(ctx.sseClients, 'validation:complete', { jobId: runId, error: errMsg, exitCode: 1 });
    }
  } finally {
    _validationRunning = false;
    _abortController = null;
  }
}
