import type { IncomingMessage, ServerResponse } from 'node:http';
import { respondJson } from '../http.js';
import { maskEventProxy } from '../sse.js';
import type { DashboardRouteContext } from '../types.js';

export function handleEventsRoute(req: IncomingMessage, res: ServerResponse, urlObj: URL, ctx: DashboardRouteContext): boolean {
  if (urlObj.pathname !== '/api/events' || req.method !== 'GET') return false;
  const limit = Math.min(parseInt(urlObj.searchParams.get('limit') || '50', 10), 2000);
  respondJson(res, { events: (ctx.eventLog?.recent(limit) || []).map(maskEventProxy) });
  return true;
}
