import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { atomicRewrite } from '../../atomicRewrite.js';
import { resolveDataDir } from '../../config/index.js';
import { EventLog } from '../../events.js';
import { parseLine } from '../../proxy/dial.js';
import { redactProxy } from '../../proxy/redact.js';
import { isSafeProxyFile } from '../auth.js';
import { respondJson, sanitizeError } from '../http.js';
import { proxyId, sanitizeProxyKey } from '../proxyKey.js';
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
    // The displayed hostname is deliberately insufficient to identify an
    // account: multiple upstreams may share the same server and port.
    const candidates = new Set([...health.entries()].map(([raw]) => raw));
    if (fs.existsSync(proxyFile)) {
      const content = await fs.promises.readFile(proxyFile, 'utf8');
      for (const line of content.split('\n')) {
        const parsed = parseLine(line);
        if (parsed) candidates.add(parsed.raw);
      }
    }
    const matches = candidates.has(key)
      ? [key]
      : (() => {
          const ids = [...candidates].filter((raw) => proxyId(raw) === key);
          return ids.length ? ids : [...candidates].filter((raw) => sanitizeProxyKey(raw) === sanitizeProxyKey(key));
        })();
    if (matches.length > 1) {
      respondJson(res, { error: 'Ambiguous proxy key; use the ID from /__stats' }, 409);
      return true;
    }
    const selected = matches[0];
    if (!selected) {
      respondJson(res, { error: 'Proxy not found' }, 404);
      return true;
    }

    let removedFromFile = false;
    if (fs.existsSync(proxyFile)) {
      await atomicRewrite(proxyFile, (content) => {
        const kept = content.split('\n').filter((line) => {
          const parsed = parseLine(line);
          if (!parsed) return true; // keep comments/blank/unparsable lines untouched
          if (parsed.raw !== selected) return true;
          removedFromFile = true;
          return false;
        });
        return removedFromFile ? kept.join('\n') : null;
      });
    }
    const removedFromHealth = health.has(selected);
    if (removedFromHealth) health.delete(selected);
    if (!removedFromFile && !removedFromHealth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy not found' }));
      return true;
    }
    const safeKey = redactProxy(selected);
    EventLog.safePush(eventLog, { type: 'pool', proxy: safeKey, target: '', status: 'info', detail: 'removed via dashboard' });
    broadcast(sseClients, 'proxy:removed', { key: safeKey, id: proxyId(selected) });
    respondJson(res, { removed: true, key: safeKey, id: proxyId(selected), removedFromFile, removedFromHealth });
  } catch (e: unknown) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeError(e) }));
  }
  return true;
}
