import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventLog, type ProxyEvent } from '../events.js';
import type { HealthEntry } from '../health/index.js';
import { redactProxy } from '../proxy/redact.js';
import type { DashboardRegistrationContext } from './types.js';

export const MAX_SSE_CLIENTS = 100;

export function maskEventProxy<T>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  const safe: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  for (const [key, value] of Object.entries(safe)) {
    if (typeof value === 'string') safe[key] = redactProxy(value);
  }
  return safe as T;
}

export function broadcast(clients: Set<ServerResponse>, event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: ServerResponse[] = [];
  const MAX_BUFFER = 64 * 1024; // 64KB per client
  for (const res of clients) {
    try {
      if (res.destroyed || res.writableEnded) {
        dead.push(res);
        continue;
      }
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
export function openSseClient(req: IncomingMessage, res: ServerResponse, sseClients: Set<ServerResponse>): void {
  // Prune dead clients before counting — collect first, delete after
  const dead: ServerResponse[] = [];
  for (const client of sseClients) {
    if (client.destroyed || client.writableEnded) dead.push(client);
  }
  for (const d of dead) sseClients.delete(d);
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many SSE clients' }));
    return;
  }
  // Check if client already disconnected
  if (res.destroyed || res.writableEnded) return;
  const corsOrigin = process.env.WINNOW_CORS_ORIGIN;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
  });
  sseClients.add(res);
  // Send connected event immediately and disable idle timeout
  res.write(':heartbeat\n\nevent: connected\ndata: {}\n\n');
  req.socket.setTimeout(0);
  const cleanup = () => {
    sseClients.delete(res);
    clearInterval(hb);
  };
  req.on('close', cleanup);
  const hb = setInterval(() => {
    if (!sseClients.has(res)) {
      clearInterval(hb);
      return;
    }
    try {
      res.write(':heartbeat\n\n');
    } catch {
      cleanup();
    }
  }, 4000);
  hb.unref();
  return;
}

export function subscribeDashboardSse(ctx: DashboardRegistrationContext, sseClients: Set<ServerResponse>): () => void {
  const { health, eventLog } = ctx;
  const cfgRef = ctx.config;
  const healthHandler = (data: unknown) => {
    broadcast(sseClients, 'health:update', maskEventProxy(data));
  };
  health.on('health:update', healthHandler);

  // LOG: subscribe to event log for live SSE broadcasting
  const eventSubscriber = (e: ProxyEvent) => broadcast(sseClients, 'proxy:event', maskEventProxy(e));
  const unsubEventLog = eventLog?.subscribe(eventSubscriber);

  // LOG: periodic pool status events
  const poolInterval = setInterval(() => {
    if (sseClients.size === 0) return;
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

  return () => {
    health.off('health:update', healthHandler);
    unsubEventLog?.();
    clearInterval(poolInterval);
  };
}
