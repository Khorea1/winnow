import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../logger.js';
import { isBlockedAfterDns, isBlockedTarget } from '../../proxy/ssrf.js';
import { readBody, respondJson, sanitizeError } from '../http.js';
import type { DashboardRouteContext, ValidationOverrides } from '../types.js';

const logger = createLogger('dashboard');

export async function handleValidateRoute(req: IncomingMessage, res: ServerResponse, urlObj: URL, ctx: DashboardRouteContext): Promise<boolean> {
  const pathname = urlObj.pathname;
  const db = ctx.db;
  if (pathname === '/api/validate' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return true;
    let custom: Partial<ValidationOverrides> = {};
    if (body.trim()) {
      try {
        custom = JSON.parse(body);
      } catch {
        respondJson(res, { error: 'Invalid JSON in request body' }, 400);
        return true;
      }
    }
    // SSRF guard: prevent custom.baseUrl from pointing to internal hosts
    if (custom.baseUrl && typeof custom.baseUrl === 'string') {
      try {
        const u = new URL(custom.baseUrl);
        if (isBlockedTarget(u.hostname) || (await isBlockedAfterDns(u.hostname))) delete custom.baseUrl;
      } catch {
        delete custom.baseUrl;
      }
    }
    if (typeof custom.threads === 'number') custom.threads = Math.max(1, Math.min(200, Math.floor(custom.threads)));
    if (typeof custom.connectTimeout === 'number') custom.connectTimeout = Math.max(1, Math.min(60, Math.floor(custom.connectTimeout)));
    if (typeof custom.maxLatency === 'number') custom.maxLatency = Math.max(100, Math.min(60000, custom.maxLatency));
    if (typeof custom.throttle === 'number') custom.throttle = Math.max(0, Math.min(10000, custom.throttle));
    if (typeof custom.ttfbRatio === 'number') custom.ttfbRatio = Math.max(0, Math.min(1000, custom.ttfbRatio));
    if (typeof custom.maxGap === 'number') custom.maxGap = Math.max(0, Math.min(60000, custom.maxGap));
    if (custom.tlsPort !== undefined) custom.tlsPort = Math.max(1, Math.min(65535, Math.floor(custom.tlsPort)));
    if (custom.tlsHost !== undefined) {
      custom.tlsHost = typeof custom.tlsHost === 'string' ? custom.tlsHost.trim() : undefined;
    }
    if (!custom.tlsHost) {
      delete custom.tlsHost;
    } else if (custom.tlsHost.includes('\0') || custom.tlsHost.length > 255) {
      delete custom.tlsHost;
    } else {
      // SSRF guard: prevent tlsHost from pointing to internal hosts
      if (isBlockedTarget(custom.tlsHost) || (await isBlockedAfterDns(custom.tlsHost))) delete custom.tlsHost;
    }
    if (custom.mode !== undefined && !['quick', 'standard', 'strict', 'stream', 'tcp-only'].includes(custom.mode)) {
      delete custom.mode;
    }
    ctx.validation.start(res, custom).catch((err) => {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'validation failed to start');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Validation failed to start' }));
      }
    });
    return true;
  }

  if (pathname === '/api/validate' && req.method === 'GET') {
    try {
      const rows = db.prepare('SELECT * FROM validation_runs ORDER BY id DESC LIMIT 20').all();
      respondJson(res, rows);
    } catch (e: unknown) {
      respondJson(res, { error: sanitizeError(e) }, 500);
    }
    return true;
  }

  if (pathname === '/api/validate/status' && req.method === 'GET') {
    respondJson(res, { running: ctx.validation.isRunning() });
    return true;
  }

  if (pathname === '/api/validate/stop' && req.method === 'POST') {
    ctx.validation.stop(res);
    return true;
  }

  return false;
}
