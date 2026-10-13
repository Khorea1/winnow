// Proxy server factory — wires CONNECT + HTTP handlers with shared connection tracking.
// Mutables (concurrent connections) are encapsulated in a closure-backed tracker,
// not module-level variables (F2 fix).

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type net from 'node:net';
import type { RotatorConfig } from '../config/index.js';
import type { EventLog } from '../events.js';
import type { HealthStore } from '../health/index.js';
import { type ConnectionTracker, handleConnect } from './connectHandler.js';
import type { ParsedProxy } from './dial.js';
import { handleHttp } from './httpHandler.js';

export interface ProxyServerCtx {
  config: { current: RotatorConfig };
  health: HealthStore;
  getProxies: () => ParsedProxy[];
  onRequestMetrics?: (info: { proxy: string; target: string; success: boolean; latency: number; bytes: number }) => void;
  eventLog?: EventLog;
}

export interface ProxyConnectionStats {
  active: number;
  limit: number;
  rejected: number;
}

const connectionTrackers = new WeakMap<http.Server, ConnectionTracker>();

/** Current proxy workload, excluding dashboard and health-check traffic. */
export function getProxyConnectionStats(server: http.Server): ProxyConnectionStats | undefined {
  const tracker = connectionTrackers.get(server);
  return tracker && { active: tracker.count, limit: tracker.max, rejected: tracker.rejected };
}

export function createProxyServer(ctx: ProxyServerCtx): http.Server {
  const config = ctx.config.current;
  const server = http.createServer();
  server.timeout = Math.max(config.timeout, 5000);
  server.keepAliveTimeout = Math.min(server.timeout, 30000);

  // Encapsulated mutable state — no module-level variable (F2 fix)
  const connections: ConnectionTracker = {
    count: 0,
    rejected: 0,
    get max() {
      return ctx.config.current.maxConnections;
    },
  };
  connectionTrackers.set(server, connections);

  const handlerCtx = {
    config: ctx.config,
    health: ctx.health,
    getProxies: ctx.getProxies,
    ...(ctx.onRequestMetrics ? { onRequestMetrics: ctx.onRequestMetrics } : {}),
    ...(ctx.eventLog ? { eventLog: ctx.eventLog } : {}),
    connections,
  };

  // --- CONNECT (HTTPS) ---
  server.on('connect', async (req: IncomingMessage, clientSock: net.Socket, head: Buffer) => {
    handleConnect(handlerCtx, req, clientSock, head);
  });

  // --- HTTP Proxy (GET http://host/path) ---
  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    handleHttp(handlerCtx, req, res);
  });

  return server;
}
