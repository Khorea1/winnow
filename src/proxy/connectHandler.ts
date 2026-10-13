// CONNECT tunnel handler for the proxy server.
// Extracted from server.ts for independent testability.

import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type net from 'node:net';
import type { RotatorConfig } from '../config/index.js';
import { EventLog } from '../events.js';
import { classifyError, type HealthStore } from '../health/index.js';
import { createLogger } from '../logger.js';
import { type ParsedProxy, parseHostPort } from './dial.js';
import { tryWithRetry } from './rotator.js';
import { isBlockedTarget } from './ssrf.js';
import { startSocketTimeout } from './timeout.js';

const logger = createLogger('proxy');

export interface ConnectionTracker {
  count: number;
  rejected: number;
  max: number;
}

export interface ConnectHandlerCtx {
  config: { current: RotatorConfig };
  health: HealthStore;
  getProxies: () => ParsedProxy[];
  onRequestMetrics?: (info: { proxy: string; target: string; success: boolean; latency: number; bytes: number }) => void;
  eventLog?: EventLog;
  connections: ConnectionTracker;
}

export function handleConnect(ctx: ConnectHandlerCtx, req: IncomingMessage, clientSock: net.Socket, head: Buffer): void {
  const reqId = crypto.randomBytes(4).toString('hex');
  const parsed = parseHostPort(req.url || '', 443);
  if (!parsed) {
    try {
      clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      return;
    }
    return;
  }
  const { host: tHost, port: tPort } = parsed;
  if (isBlockedTarget(tHost)) {
    try {
      clientSock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    } catch {
      return;
    }
    return;
  }
  const conn = ctx.connections;
  if (conn.count >= conn.max) {
    conn.rejected++;
    try {
      clientSock.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    } catch {
      return;
    }
    return;
  }
  conn.count++;
  // CONNECT stays active until the client TCP socket actually closes.
  clientSock.once('close', () => {
    conn.count--;
  });
  const targetKey = `${tHost}:${tPort}`;
  const config = ctx.config.current;
  const proxies = ctx.getProxies();
  const el = ctx.eventLog;
  let cancelTimeout: (() => void) | undefined;

  try {
    tryWithRetry(proxies, ctx.health, config, tHost, tPort, el, reqId)
      .then(({ sock: upSock, head: upHead, upstream, latency: dialLatency }) => {
        if (clientSock.destroyed) {
          upSock.destroy();
          return;
        }
        logger.info({ reqId, proxy: upstream.raw, target: targetKey, latency: dialLatency }, 'connect upstream acquired');
        EventLog.safePush(el, { type: 'connect', proxy: upstream.raw, target: targetKey, status: 'success', latency: dialLatency });

        let bytesUp = 0;
        let bytesDown = 0;
        let failed = false;
        const start = Date.now();

        const onUpData = (chunk: Buffer) => {
          bytesDown += chunk.length;
          const ok = clientSock.write(chunk);
          if (!ok) upSock.pause();
        };
        const onClientData = (chunk: Buffer) => {
          bytesUp += chunk.length;
          const ok = upSock.write(chunk);
          if (!ok) clientSock.pause();
        };
        upSock.on('data', onUpData);
        clientSock.on('data', onClientData);
        clientSock.on('drain', () => upSock.resume());
        upSock.on('drain', () => clientSock.resume());
        upSock.on('end', () => clientSock.end());
        clientSock.on('end', () => upSock.end());
        cancelTimeout = startSocketTimeout([upSock, clientSock], Math.max(config.timeout, 15000), config.upstreamIdleTimeout || config.timeout * 2, () => {
          if (failed) return;
          failed = true;
          logger.warn({ reqId, proxy: upstream.raw, target: targetKey }, 'tunnel timeout');
          ctx.health.recordFailure(upstream.raw, targetKey, { message: 'tunnel timeout' }, config);
          try {
            upSock.destroy();
            clientSock.destroy();
          } catch {}
        });

        try {
          clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        } catch {
          cancelTimeout?.();
          failed = true;
          try {
            upSock.destroy();
          } catch {}
          return;
        }

        if (head?.length) {
          upSock.write(head);
          bytesUp += head.length;
        }
        if (upHead?.length) {
          clientSock.write(upHead);
          bytesDown += upHead.length;
        }

        const markFailure = (err?: unknown) => {
          if (failed) return;
          failed = true;
          ctx.health.recordFailure(upstream.raw, targetKey, err || { message: 'proxy error' }, config);
          const errMsg = err instanceof Error ? err.message : err ? String(err) : 'proxy error';
          const errCode = err != null && typeof err === 'object' && 'code' in err ? String((err as Record<string, unknown>).code) : undefined;
          logger.warn({ reqId, proxy: upstream.raw, target: targetKey, error: errMsg, errorClass: classifyError(err) }, 'connect failure');
          EventLog.safePush(el, {
            type: 'connect',
            proxy: upstream.raw,
            target: targetKey,
            status: 'failure',
            error: errMsg,
            errorCode: errCode,
            errorClass: classifyError(err),
          });
        };

        const markSuccess = () => {
          if (failed) return;
          failed = true;
          const totalBytes = bytesUp + bytesDown;
          const totalLatency = Date.now() - start;
          ctx.health.recordSuccess(upstream.raw, targetKey, dialLatency, start);
          ctx.onRequestMetrics?.({ proxy: upstream.raw, target: targetKey, success: true, latency: totalLatency, bytes: totalBytes });
          logger.info({ reqId, proxy: upstream.raw, target: targetKey, bytes: totalBytes, latency: totalLatency }, 'tunnel completed');
        };
        clientSock.on('error', (err: Error) => {
          logger.debug({ error: err.message, reqId }, 'client socket error');
        });
        upSock.on('error', (err: Error) => {
          markFailure(err);
          try {
            upSock.destroy();
          } catch {}
          try {
            clientSock.destroy();
          } catch {}
        });

        upSock.on('close', () => {
          cancelTimeout?.();
          if (failed) return;
          const elapsed = Date.now() - start;
          if (elapsed < 500 && bytesDown === 0 && bytesUp < 100) {
            markFailure(new Error('early close'));
          } else {
            markSuccess();
          }
          try {
            clientSock.end();
          } catch {}
        });
        clientSock.on('close', () => {
          if (failed) return;
          cancelTimeout?.();
          try {
            upSock.destroy();
          } catch {}
        });
      })
      .catch((e: unknown) => {
        cancelTimeout?.();
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes('blocked by SSRF')) {
          try {
            clientSock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          } catch {}
          return;
        }
        const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
        logger.error({ reqId, target: targetKey, error: errMsg }, 'connect all retries failed');
        EventLog.safePush(el, {
          type: 'connect',
          proxy: '(all)',
          target: targetKey,
          status: 'failure',
          error: errMsg,
          errorCode: errCode,
        });
        try {
          clientSock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {}
        clientSock.end();
      });
  } catch (e: unknown) {
    cancelTimeout?.();
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg.includes('blocked by SSRF')) {
      try {
        clientSock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      } catch {}
      return;
    }
    const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
    logger.error({ reqId, target: targetKey, error: errMsg }, 'connect all retries failed');
    EventLog.safePush(el, {
      type: 'connect',
      proxy: '(all)',
      target: targetKey,
      status: 'failure',
      error: errMsg,
      errorCode: errCode,
    });
    try {
      clientSock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch {}
    clientSock.end();
  }
}
