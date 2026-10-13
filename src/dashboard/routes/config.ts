import type { IncomingMessage, ServerResponse } from 'node:http';
import { updateConfig } from '../../config/index.js';
import { readBody, respondJson } from '../http.js';
import type { DashboardRouteContext } from '../types.js';

export async function handleConfigRoute(req: IncomingMessage, res: ServerResponse, pathname: string, ctx: DashboardRouteContext): Promise<boolean> {
  if (pathname !== '/api/config') return false;
  if (req.method === 'GET') {
    respondJson(res, ctx.config.current);
    return true;
  }
  if (req.method !== 'POST') return false;

  const body = await readBody(req, res);
  if (body === null) return true;
  try {
    const patch = JSON.parse(body);
    const updated = updateConfig(patch, { ...ctx.config.current });
    Object.assign(ctx.config.current, updated);
    ctx.onConfigChange?.(updated);
    if (typeof updated.timeout === 'number') {
      ctx.server.timeout = Math.max(updated.timeout, 5000);
      ctx.server.keepAliveTimeout = Math.min(ctx.server.timeout, 30000);
    }
    respondJson(res, updated);
  } catch (error: unknown) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
