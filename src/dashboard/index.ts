import fs from 'node:fs';
import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { isAuthorized } from './auth.js';
import { respondJson, sanitizeError } from './http.js';
import { handleConfigRoute } from './routes/config.js';
import { handleEventsRoute } from './routes/events.js';
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
let _unsubscribeSse: (() => void) | undefined;
let _dashboardHtml: string | null = null;
export function unsubscribeDashboard() {
  _unsubscribeSse?.();
  _unsubscribeSse = undefined;
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
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; base-uri 'self'",
    });
    res.end(_dashboardHtml);
  } catch (e: unknown) {
    res.writeHead(500);
    res.end(`Dashboard error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerDashboard(server: http.Server, ctx: DashboardRegistrationContext) {
  const sseClients = new Set<ServerResponse>();
  const validation = createValidationManager(ctx, sseClients);
  const routes: DashboardRouteContext = { ...ctx, server, sseClients, validation };
  _unsubscribeSse?.();
  _unsubscribeSse = subscribeDashboardSse(ctx, sseClients);

  const origListeners = server.listeners('request');

  server.prependListener('request', async (req: IncomingMessage, res: ServerResponse) => {
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

      if (await handleConfigRoute(req, res, urlObj, routes)) return;
      if (await handleEventsRoute(req, res, urlObj, routes)) return;
      if (await handleProxyRoute(req, res, urlObj, routes)) return;
      if (await handleValidateRoute(req, res, urlObj, routes)) return;
      if (handleStatsRoute(res, pathname, routes)) return;
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

      if (pathname === '/dashboard') {
        serveDashboard(res);
        return;
      }

      // Not a dashboard route — fall through to original listeners (HTTP proxy handler)
      // When prependListener is used, original listeners fire automatically.
      // If no original listeners exist, return 404 to avoid hanging.
      if (!origListeners.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
    } catch (e: unknown) {
      logger.error({ error: e instanceof Error ? e.message : String(e) }, 'dashboard: unhandled request error');
      try {
        respondJson(res, { error: sanitizeError(e) }, 500);
      } catch {}
    }
  });
}
