import type { IncomingMessage, ServerResponse } from 'node:http';
import { updateConfig } from '../../config/index.js';
import { applyServerTimeouts } from '../../proxy/server.js';
import { readBody, respondJson } from '../http.js';
import type { DashboardRouteContext } from '../types.js';

export async function handleConfigRoute(req: IncomingMessage, res: ServerResponse, urlObj: URL, ctx: DashboardRouteContext): Promise<boolean> {
  if (urlObj.pathname !== '/api/config') return false;
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
    applyServerTimeouts(ctx.server, updated);
    respondJson(res, updated);
  } catch (error: unknown) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
