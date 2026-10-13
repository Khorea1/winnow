import fs from 'node:fs';
import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { isAuthorized } from './auth.js';
import { respondJson, sanitizeError } from './http.js';
import { handleConfigRoute } from './routes/config.js';
import { handleEventsRoute } from './routes/events.js';
import { handleMetricsRoute } from './routes/metrics.js';
import { handleProxyRoute } from './routes/proxy.js';
import { handleStatsRoute } from './routes/stats.js';
import { handleValidateRoute } from './routes/validate.js';
import { openSseClient, subscribeDashboardSse } from './sse.js';
import type { DashboardRegistrationContext, DashboardRouteContext } from './types.js';
import { createValidationManager } from './validation-run.js';

const logger = createLogger('dashboard');

const _DASHBOARD_PATH = path.join(import.meta.dirname, '../../public/dashboard.html');
const _DASHBOARD_CSS_PATH = path.join(import.meta.dirname, '../../public/dashboard.css');
const _DASHBOARD_JS_PATH = path.join(import.meta.dirname, '../../public/dashboard.js');
const _DASHBOARD_UTILS_PATH = path.join(import.meta.dirname, '../../public/dashboard-utils.js');
let _unsubscribeSse: (() => void) | undefined;
let _abortValidation: (() => void) | undefined;
let _dashboardHtml: string | null = null;
export function unsubscribeDashboard() {
  _abortValidation?.();
  _abortValidation = undefined;
  _unsubscribeSse?.();
  _unsubscribeSse = undefined;
}

export function readDashboardHtml(candidates: readonly string[], cache: boolean): string {
  if (cache && _dashboardHtml) return _dashboardHtml;
  let html = '<html><body><h1>Dashboard not found</h1></body></html>';
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      html = fs.readFileSync(candidate, 'utf8');
      break;
    }
  }
  if (cache) _dashboardHtml = html;
  return html;
}

function serveDashboard(res: ServerResponse) {
  try {
    const html = readDashboardHtml([_DASHBOARD_PATH, path.join(process.cwd(), 'public/dashboard.html')], process.env.NODE_ENV === 'production');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'",
    });
    res.end(html);
  } catch (e: unknown) {
    res.writeHead(500);
    res.end(`Dashboard error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerDashboard(server: http.Server, ctx: DashboardRegistrationContext) {
  const sseClients = new Set<ServerResponse>();
  const validation = createValidationManager(ctx, sseClients);
  _abortValidation = validation.abort;
  const routes: DashboardRouteContext = { ...ctx, server, sseClients, validation };
  _unsubscribeSse?.();
  _unsubscribeSse = subscribeDashboardSse(ctx, sseClients);
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const rateSweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(ip);
  }, 60_000).unref();
  const prevUnsubscribe = _unsubscribeSse;
  _unsubscribeSse = () => {
    clearInterval(rateSweep);
    prevUnsubscribe?.();
  };

  const origListeners = server.listeners('request');

  // EventEmitter calls every listener even if an earlier one ended the response.
  // Dispatch dashboard routes here and only invoke proxy listeners for other traffic.
  server.removeAllListeners('request');
  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlObj = new URL(req.url || '/', 'http://localhost');
      const pathname = urlObj.pathname;
      const needsAuth =
        pathname.startsWith('/api/') ||
        pathname === '/dashboard' ||
        pathname === '/events' ||
        pathname === '/metrics' ||
        pathname === '/__stats' ||
        pathname === '/dashboard.js' ||
        pathname === '/dashboard.css' ||
        pathname === '/dashboard-utils.js';

      if (needsAuth && !isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
        const ip = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const bucket = rateBuckets.get(ip);
        if (!bucket || bucket.resetAt <= now) {
          rateBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
        } else if (bucket.count >= 10) {
          respondJson(res, { error: 'Too many requests' }, 429);
          return;
        } else {
          bucket.count++;
        }
      }

      if (pathname === '/') {
        res.writeHead(302, { Location: '/dashboard' });
        res.end();
        return;
      }

      if (await handleConfigRoute(req, res, urlObj, routes)) return;
      if (await handleEventsRoute(req, res, urlObj, routes)) return;
      if (await handleProxyRoute(req, res, urlObj, routes)) return;
      if (await handleValidateRoute(req, res, urlObj, routes)) return;
      if (handleStatsRoute(res, pathname, routes)) return;
      if (handleMetricsRoute(req, res, pathname, routes)) return;
      if (pathname === '/events') {
        openSseClient(req, res, sseClients);
        return;
      }
      if (pathname === '/dashboard.css') {
        try {
          const css = fs.readFileSync(_DASHBOARD_CSS_PATH, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(css);
        } catch {
          res.writeHead(404);
          res.end('/* not found */');
        }
        return;
      }

      if (pathname === '/dashboard.js') {
        try {
          const js = fs.readFileSync(_DASHBOARD_JS_PATH, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(js);
        } catch {
          res.writeHead(404);
          res.end('// not found');
        }
        return;
      }

      if (pathname === '/dashboard-utils.js') {
        try {
          const js = fs.readFileSync(_DASHBOARD_UTILS_PATH, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(js);
        } catch {
          res.writeHead(404);
          res.end('// not found');
        }
        return;
      }

      if (pathname === '/dashboard') {
        serveDashboard(res);
        return;
      }

      // Never send unrecognized API requests through the outbound proxy.
      if (pathname.startsWith('/api/') || !origListeners.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      for (const listener of origListeners) listener.call(server, req, res);
    } catch (e: unknown) {
      logger.error({ error: e instanceof Error ? e.message : String(e) }, 'dashboard: unhandled request error');
      try {
        respondJson(res, { error: sanitizeError(e) }, 500);
      } catch {}
    }
  });
}
