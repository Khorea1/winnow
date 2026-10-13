import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { atomicRewrite } from '../../atomicRewrite.js';
import { resolveDataDir } from '../../config/index.js';
import { EventLog } from '../../events.js';
import { parseLine } from '../../proxy/dial.js';
import { isSafeProxyFile } from '../auth.js';
import { respondJson, sanitizeError } from '../http.js';
import { sanitizeProxyKey } from '../proxyKey.js';
import { broadcast } from '../sse.js';
import type { DashboardRouteContext } from '../types.js';

export async function handleProxyRoute(req: IncomingMessage, res: ServerResponse, urlObj: URL, ctx: DashboardRouteContext): Promise<boolean> {
  if (urlObj.pathname !== '/api/proxy' || req.method !== 'DELETE') return false;
  // Prefer X-Proxy-Key to avoid leaking credentials to URL logs.
  const { health, eventLog, sseClients } = ctx;
  const cfgRef = ctx.config;

  const key = (typeof req.headers['x-proxy-key'] === 'string' ? req.headers['x-proxy-key'] : urlObj.searchParams.get('key')) as string | null;
  if (!key) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing key parameter' }));
    return true;
  }
  const proxyFile = cfgRef.current.proxyFile;
  const abs = path.resolve(proxyFile);
  if (!isSafeProxyFile(abs, resolveDataDir())) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unsafe proxyFile' }));
    return true;
  }
  try {
    let removedFromFile = false;
    if (fs.existsSync(proxyFile)) {
      await atomicRewrite(proxyFile, (content) => {
        const kept = content.split('\n').filter((line) => {
          const parsed = parseLine(line);
          if (!parsed) return true; // keep comments/blank/unparsable lines untouched
          if (sanitizeProxyKey(parsed.raw) !== sanitizeProxyKey(key)) return true;
          removedFromFile = true;
          return false;
        });
        return removedFromFile ? kept.join('\n') : null;
      });
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
      return true;
    }
    const safeKey = sanitizeProxyKey(key);
    EventLog.safePush(eventLog, { type: 'pool', proxy: safeKey, target: '', status: 'info', detail: 'removed via dashboard' });
    broadcast(sseClients, 'proxy:removed', { key: safeKey });
    respondJson(res, { removed: true, key: safeKey, removedFromFile, removedFromHealth });
  } catch (e: unknown) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeError(e) }));
  }
  return true;
}
