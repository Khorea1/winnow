import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactProxy } from '../proxy/redact.js';

export const MAX_SSE_CLIENTS = 100;

export function maskEventProxy<T>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  const safe: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  for (const [key, value] of Object.entries(safe)) {
    if (typeof value === 'string') safe[key] = redactProxy(value);
  }
  return safe as T;
}

export function broadcast(clients: Set<ServerResponse>, event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead: ServerResponse[] = [];
  const maxBuffer = 64 * 1024;
  for (const res of clients) {
    try {
      if (res.destroyed || res.writableEnded || res.writableLength > maxBuffer) {
        dead.push(res);
        continue;
      }
      res.write(message);
    } catch {
      dead.push(res);
    }
  }
  for (const res of dead) clients.delete(res);
}

export function openSseClient(req: IncomingMessage, res: ServerResponse, clients: Set<ServerResponse>): void {
  for (const client of clients) {
    if (client.destroyed || client.writableEnded) clients.delete(client);
  }
  if (clients.size >= MAX_SSE_CLIENTS) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many SSE clients' }));
    return;
  }
  if (res.destroyed || res.writableEnded) return;

  const corsOrigin = process.env.WINNOW_CORS_ORIGIN;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
  });
  clients.add(res);
  res.write(':heartbeat\n\nevent: connected\ndata: {}\n\n');
  req.socket.setTimeout(0);
  let heartbeat: NodeJS.Timeout;
  const cleanup = () => {
    clients.delete(res);
    clearInterval(heartbeat);
  };
  req.on('close', cleanup);
  heartbeat = setInterval(() => {
    if (!clients.has(res)) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(':heartbeat\n\n');
    } catch {
      cleanup();
    }
  }, 4000);
  heartbeat.unref();
}
