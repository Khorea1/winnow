import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type net from 'node:net';
import type { RotatorConfig } from '../config/index.js';
import { EventLog } from '../events.js';
import { classifyError, type HealthStore } from '../health/index.js';
import { createLogger } from '../logger.js';
import { isBlockedTarget, type ParsedProxy, parseHostPort } from './dial.js';
import { tryWithRetry } from './rotator.js';

const logger = createLogger('proxy');

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// Hop-by-hop headers that MUST NOT be forwarded by an HTTP proxy (RFC 2616 §13.5.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

// ── Upstream timeout helpers ──────────────────────────────────────────────
// TTFB + idle timeout for single-socket upstream or bi-directional CONNECT.
function startSocketTimeout(sockets: net.Socket[], ttfbMs: number, idleMs: number, onTimeout: () => void): () => void {
  let ttfbTimer: NodeJS.Timeout | null = setTimeout(() => {
    const t = idleTimer;
    ttfbTimer = null;
    idleTimer = null;
    if (t) clearTimeout(t);
    onTimeout();
  }, ttfbMs);
  let idleTimer: NodeJS.Timeout | null = null;

  function onData() {
    if (ttfbTimer) {
      clearTimeout(ttfbTimer);
      ttfbTimer = null;
      idleTimer = setTimeout(onTimeout, idleMs);
    } else if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onTimeout, idleMs);
    }
  }

  for (const s of sockets) s.on('data', onData);

  return function cancel() {
    if (ttfbTimer) {
      clearTimeout(ttfbTimer);
      ttfbTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const s of sockets) s.off('data', onData);
  };
}
export interface ProxyServerCtx {
  config: { current: RotatorConfig };
  health: HealthStore;
  getProxies: () => ParsedProxy[];
  onRequestMetrics?: (info: { proxy: string; target: string; success: boolean; latency: number; bytes: number }) => void;
  eventLog?: EventLog;
}

export function createProxyServer(ctx: ProxyServerCtx): http.Server {
  const config = ctx.config.current;
  const server = http.createServer();
  // Idle connection timeout — prevents resource leaks from clients that connect
  // and never send a request. Tunnels (CONNECT) are unaffected since pipe takes over.
  server.timeout = Math.max(config.timeout, 5000);
  server.keepAliveTimeout = Math.min(server.timeout, 30000);
  // --- CONNECT (HTTPS) ---
  server.on('connect', async (req, clientSock: net.Socket, head: Buffer) => {
    const reqId = shortId();
    const parsed = parseHostPort(req.url || '', 443);
    if (!parsed) {
      try {
        clientSock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {}
      clientSock.end();
      return;
    }
    const { host: tHost, port: tPort } = parsed;
    if (isBlockedTarget(tHost)) {
      try {
        clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      } catch {}
      clientSock.end();
      return;
    }
    const targetKey = `${tHost}:${tPort}`;
    const config = ctx.config.current;
    const proxies = ctx.getProxies();
    const el = ctx.eventLog;
    let cancelTimeout: (() => void) | undefined;

    try {
      const {
        sock: upSock,
        head: upHead,
        upstream,
        latency: dialLatency,
      } = await tryWithRetry(proxies, ctx.health, config, tHost, tPort, targetKey, el, reqId);

      logger.info({ reqId, proxy: upstream.raw, target: targetKey, latency: dialLatency }, 'connect upstream acquired');
      EventLog.safePush(el, { type: 'connect', proxy: upstream.raw, target: targetKey, status: 'success', latency: dialLatency });

      // Track real usage
      let bytesUp = 0;
      let bytesDown = 0;
      let failed = false;
      let _closedEarly = false;
      const start = Date.now();

      try {
        clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      } catch {
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

      // Pipe with byte counting
      const onUpData = (chunk: Buffer) => {
        bytesDown += chunk.length;
      };
      const onClientData = (chunk: Buffer) => {
        bytesUp += chunk.length;
      };
      upSock.on('data', onUpData);
      clientSock.on('data', onClientData);

      upSock.pipe(clientSock);
      clientSock.pipe(upSock);
      // Timeout: TTFB on first data, idle after
      cancelTimeout = startSocketTimeout([upSock, clientSock], config.timeout, config.upstreamIdleTimeout || config.timeout * 2, () => {
        if (failed) return;
        failed = true;
        logger.warn({ reqId, proxy: upstream.raw, target: targetKey }, 'tunnel timeout');
        ctx.health.recordFailure(upstream.raw, targetKey, { message: 'tunnel timeout' }, config);
        try {
          upSock.destroy();
          clientSock.destroy();
        } catch {}
      });

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

      clientSock.on('error', () => {
        /* client error does not penalize proxy */
      });

      upSock.on('close', () => {
        cancelTimeout?.();
        const elapsed = Date.now() - start;
        if (elapsed < 500 && bytesDown === 0 && bytesUp < 100) {
          _closedEarly = true;
          EventLog.safePush(el, { type: 'connect', proxy: upstream.raw, target: targetKey, status: 'failure', error: 'early close', errorClass: 'transient' });
          markFailure(new Error('early close'));
        } else {
          markSuccess();
        }
        try {
          clientSock.end();
        } catch {}
      });
      clientSock.on('close', () => {
        cancelTimeout?.();
        if (bytesDown > 0) markSuccess();
        try {
          upSock.end();
        } catch {}
      });
    } catch (e: unknown) {
      cancelTimeout?.();
      const errMsg = e instanceof Error ? e.message : String(e);
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
  });

  // --- HTTP Proxy (GET http://host/path) ---
  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    const reqId = shortId();
    // HTTP proxy forwarding real
    let cancelTimeout: (() => void) | undefined;
    const el = ctx.eventLog;
    let targetKey = '';
    try {
      let targetUrl: URL;
      try {
        targetUrl = new URL(req.url ?? '/');
      } catch {
        // req.url may be path only, use Host header
        const host = req.headers.host;
        if (!host) {
          res.writeHead(400);
          res.end('Bad Request');
          return;
        }
        targetUrl = new URL(`http://${host}${req.url ?? '/'}`);
      }

      const tHost = targetUrl.hostname;
      const tPort = parseInt(targetUrl.port, 10) || (targetUrl.protocol === 'https:' ? 443 : 80);
      if (isBlockedTarget(tHost)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      targetKey = `${tHost}:${tPort}`;
      const config = ctx.config.current;
      const proxies = ctx.getProxies();
      const { sock: upSock, upstream, latency: dialLatency } = await tryWithRetry(proxies, ctx.health, config, tHost, tPort, targetKey, el, reqId);

      logger.info({ reqId, proxy: upstream.raw, target: targetKey, latency: dialLatency }, 'http upstream acquired');
      EventLog.safePush(el, { type: 'http', proxy: upstream.raw, target: targetKey, status: 'success', latency: dialLatency });
      let requestFailed = false;
      let upstreamBytes = 0;
      let requestBodyBytes = 0;
      const startTime = Date.now();
      const markHttpFailure = (err?: unknown) => {
        if (requestFailed) return;
        requestFailed = true;
        ctx.health.recordFailure(upstream.raw, targetKey, err || { message: 'http proxy error' }, config);
        const errMsg = err instanceof Error ? err.message : err ? String(err) : 'http proxy error';
        const errCode = err != null && typeof err === 'object' && 'code' in err ? String((err as Record<string, unknown>).code) : undefined;
        logger.warn({ reqId, proxy: upstream.raw, target: targetKey, error: errMsg, errorClass: classifyError(err) }, 'http failure');
        EventLog.safePush(el, {
          type: 'http',
          proxy: upstream.raw,
          target: targetKey,
          status: 'failure',
          error: errMsg,
          errorCode: errCode,
          errorClass: classifyError(err),
        });
      };

      // Send request to upstream
      const pathAndQuery = targetUrl.pathname + targetUrl.search;
      let headers = '';
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', ...HOP_BY_HOP].includes(k.toLowerCase())) continue;
        if (Array.isArray(v)) headers += `${k}: ${v.join(', ')}\r\n`;
        else if (v) headers += `${k}: ${v}\r\n`;
      }
      const reqLine = `${req.method} ${pathAndQuery} HTTP/1.1\r\nHost: ${tHost}\r\n${headers}Connection: close\r\n\r\n`;
      upSock.write(reqLine);
      cancelTimeout = startSocketTimeout([upSock], config.timeout, config.upstreamIdleTimeout || config.timeout * 2, () => {
        if (requestFailed) return;
        requestFailed = true;
        ctx.health.recordFailure(upstream.raw, targetKey, { message: 'upstream timeout' }, config);
        logger.warn({ reqId, proxy: upstream.raw, target: targetKey }, 'upstream timeout');
        EventLog.safePush(el, { type: 'http', proxy: upstream.raw, target: targetKey, status: 'failure', error: 'upstream timeout', errorClass: 'transient' });
        upSock.destroy();
        try {
          res.end();
        } catch {}
      });

      const MAX_BODY_BYTES = 10 * 1024 * 1024;
      let bodyBytes = 0;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.on('data', (chunk: Buffer) => {
          requestBodyBytes += chunk.length;
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_BODY_BYTES && !requestFailed) {
            req.unpipe(upSock);
            req.destroy();
            upSock.destroy();
            requestFailed = true;
            res.writeHead(413, { 'Content-Type': 'text/plain' });
            res.end('Payload Too Large');
          }
        });
        req.pipe(upSock);
      }

      // Read upstream response and forward — parse headers, filter hop-by-hop, pass to client
      let respBuf: Buffer = Buffer.alloc(0);
      let headerParsed = false;
      let statusCode = 0;

      upSock.on('data', (chunk: Buffer) => {
        if (!headerParsed) {
          const combined = respBuf.length > 0 ? Buffer.concat([respBuf, chunk]) : chunk;
          const idx = combined.indexOf('\r\n\r\n');
          if (idx !== -1) {
            let headerStr = combined.slice(0, idx).toString();
            let lines = headerStr.split('\r\n');
            let firstLine = lines[0] || '';
            statusCode = parseInt(firstLine.split(' ')[1] || '0', 10);
            let rest = combined.slice(idx + 4);

            // Handle 100-Continue — consume interim responses until we get a final one
            while (statusCode === 100 && rest.length > 0) {
              const nextIdx = rest.indexOf('\r\n\r\n');
              if (nextIdx === -1) {
                respBuf = rest;
                return;
              }
              headerStr = rest.slice(0, nextIdx).toString();
              lines = headerStr.split('\r\n');
              firstLine = lines[0] || '';
              statusCode = parseInt(firstLine.split(' ')[1] || '0', 10);
              rest = rest.slice(nextIdx + 4);
            }

            if (statusCode === 100 && rest.length === 0) {
              respBuf = Buffer.alloc(0);
              return;
            }

            if (statusCode >= 500 && !requestFailed) {
              EventLog.safePush(el, {
                type: 'http',
                proxy: upstream.raw,
                target: targetKey,
                status: 'failure',
                error: `upstream ${statusCode}`,
                errorClass: 'transient',
              });
              markHttpFailure(new Error(`upstream ${statusCode}`));
            }
            const headers: Record<string, string | string[]> = {};
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              const sep = line.indexOf(':');
              if (sep === -1) continue;
              const k = line.slice(0, sep).trim();
              const v = line.slice(sep + 1).trim();
              if (k && !HOP_BY_HOP.has(k.toLowerCase())) {
                const existing = headers[k];
                if (existing !== undefined) {
                  headers[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
                } else {
                  headers[k] = v;
                }
              }
            }
            try {
              res.writeHead(statusCode, headers);
              if (rest.length) res.write(rest);
            } catch {}
            upstreamBytes += rest.length;
            headerParsed = true;
            respBuf = Buffer.alloc(0);
          } else {
            respBuf = combined;
          }
        } else {
          try {
            res.write(chunk);
          } catch {}
          upstreamBytes += chunk.length;
        }
      });

      upSock.on('end', () => {
        cancelTimeout?.();
        const totalTime = Date.now() - startTime;
        if (!requestFailed) {
          ctx.health.recordSuccess(upstream.raw, targetKey, dialLatency, Date.now());
          ctx.onRequestMetrics?.({ proxy: upstream.raw, target: targetKey, success: true, latency: totalTime, bytes: upstreamBytes + requestBodyBytes });
          logger.info(
            { reqId, proxy: upstream.raw, target: targetKey, statusCode, bytes: upstreamBytes + requestBodyBytes, latency: totalTime },
            'http request completed',
          );
        }
        try {
          res.end();
        } catch {}
      });

      upSock.on('error', (err: Error) => {
        cancelTimeout?.();
        const totalTime = Date.now() - startTime;
        try {
          res.writeHead(502);
          res.end('Bad Gateway');
        } catch {}
        if (!requestFailed) {
          markHttpFailure(err);
          ctx.onRequestMetrics?.({ proxy: upstream.raw, target: targetKey, success: false, latency: totalTime, bytes: upstreamBytes + requestBodyBytes });
        }
      });
      req.on('error', () => {
        try {
          upSock.destroy();
        } catch {}
      });
      res.on('close', () => {
        try {
          upSock.destroy();
        } catch {}
      });
    } catch (e: unknown) {
      if (cancelTimeout) cancelTimeout();
      const errMsg = e instanceof Error ? e.message : String(e);
      const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
      logger.error({ reqId, target: targetKey, error: errMsg }, 'http all retries failed');
      EventLog.safePush(el, { type: 'http', proxy: '(all)', target: targetKey, status: 'failure', error: errMsg, errorCode: errCode });
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Bad Gateway: ${errMsg}`);
      } catch {}
    }
  });
  return server;
}
