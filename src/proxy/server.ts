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
const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
  'proxy-connection': true,
};
// Pre-built set for request-header stripping — avoids allocating a new array
// on every iteration of every header on every request.
const STRIPPED_REQUEST_HEADERS: Record<string, true> = {
  host: true,
  ...HOP_BY_HOP,
};

// Maximum acceptable size for upstream response headers (prevents unbounded
// memory growth if the upstream sends data without a \r\n\r\n terminator).
const MAX_RESPONSE_HEADER_BYTES = 32768;
let concurrentConnections = 0;
const MAX_CONCURRENT_CONNECTIONS = 1000;

// ── Upstream timeout helpers ──────────────────────────────────────────────
// TTFB + idle timeout for single-socket upstream or bi-directional CONNECT.
function startSocketTimeout(sockets: net.Socket[], ttfbMs: number, idleMs: number, onTimeout: () => void): () => void {
  let ttfbTimer: NodeJS.Timeout | null = setTimeout(() => {
    if (ttfbTimer === null) return;
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
      clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const { host: tHost, port: tPort } = parsed;
    if (isBlockedTarget(tHost)) {
      clientSock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (concurrentConnections >= MAX_CONCURRENT_CONNECTIONS) {
      clientSock.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    concurrentConnections++;
    const targetKey = `${tHost}:${tPort}`;
    const config = ctx.config.current;
    const proxies = ctx.getProxies();
    const el = ctx.eventLog;
    let cancelTimeout: (() => void) | undefined;

    try {
      const { sock: upSock, head: upHead, upstream, latency: dialLatency } = await tryWithRetry(proxies, ctx.health, config, tHost, tPort, el, reqId);

      logger.info({ reqId, proxy: upstream.raw, target: targetKey, latency: dialLatency }, 'connect upstream acquired');
      EventLog.safePush(el, { type: 'connect', proxy: upstream.raw, target: targetKey, status: 'success', latency: dialLatency });

      // Track real usage
      let bytesUp = 0;
      let bytesDown = 0;
      let failed = false;
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

      // ── Data forwarding with byte counting (manual pipe) ─────────────────
      // We use manual forwarding instead of .pipe() so we can count bytes
      // without attaching separate 'data' listeners that would fire alongside
      // pipe() — that would double-process every chunk.
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
      // Timeout: TTFB on first data, idle after
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
      // Must listen to upSock error to prevent unhandled error crashing the process
      upSock.on('error', (err: Error) => {
        markFailure(err);
        try {
          upSock.destroy();
        } catch {}
        try {
          clientSock.destroy();
        } catch {}
      });

      // ── Close handling ───────────────────────────────────────────────────
      // Only upSock.close() records health (success/failure). We use its
      // authoritative view of the upstream connection lifecycle:
      //   - An "early close" (<500ms, no data, <100 bytes up) implies the
      //     upstream rejected the tunnel without a clear HTTP error.
      //   - Otherwise the tunnel completed normally.
      // clientSock.close() never scores health — it only destroys the upstream
      // socket for a clean shutdown on the client side.
      upSock.on('close', () => {
        cancelTimeout?.();
        if (failed) return;
        const elapsed = Date.now() - start;
        if (elapsed < 500 && bytesDown === 0 && bytesUp < 100) {
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
        if (failed) return;
        cancelTimeout?.();
        // client close — no health scoring; only clean up the upstream side
        try {
          upSock.destroy();
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
    } finally {
      concurrentConnections--;
    }
  });

  // --- HTTP Proxy (GET http://host/path) ---
  server.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    const reqId = shortId();
    // HTTP proxy forwarding real
    let cancelTimeout: (() => void) | undefined;
    const el = ctx.eventLog;
    let targetKey = '';
    if (concurrentConnections >= MAX_CONCURRENT_CONNECTIONS) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
      return;
    }
    concurrentConnections++;
    try {
      let targetUrl: URL;
      try {
        targetUrl = new URL(req.url ?? '/');
        if (!targetUrl.hostname) throw new Error('relative URL');
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
      const { sock: upSock, head: upHead, upstream, latency: dialLatency } = await tryWithRetry(proxies, ctx.health, config, tHost, tPort, el, reqId);

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
      if (upHead?.length) {
        markHttpFailure(new Error('upstream sent data before response'));
        upSock.destroy();
        return;
      }

      // Send request to upstream — preserve original header casing via rawHeaders
      const pathAndQuery = targetUrl.pathname + targetUrl.search;
      let reqHeaderLines = '';
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i].replace(/[\r\n]/g, '').trim();
        if (k.toLowerCase() in STRIPPED_REQUEST_HEADERS) continue;
        const v = req.rawHeaders[i + 1].replace(/[\r\n]/g, '').trim();
        reqHeaderLines += `${k}: ${v}\r\n`;
      }
      // Use targetUrl.host to include port when non-default (e.g. Host: example.com:8080)
      const reqLine = `${req.method} ${pathAndQuery} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n${reqHeaderLines}Connection: keep-alive\r\n\r\n`;
      upSock.write(reqLine);
      // Also watch client socket — slow client body send shouldn't kill upstream timeout
      cancelTimeout = startSocketTimeout([upSock, req.socket], config.timeout, config.upstreamIdleTimeout || config.timeout * 2, () => {
        if (requestFailed) return;
        requestFailed = true;
        ctx.health.recordFailure(upstream.raw, targetKey, { message: 'upstream timeout' }, config);
        logger.warn({ reqId, proxy: upstream.raw, target: targetKey }, 'upstream timeout');
        EventLog.safePush(el, { type: 'http', proxy: upstream.raw, target: targetKey, status: 'failure', error: 'upstream timeout', errorClass: 'transient' });
        upSock.destroy();
        try {
          if (!res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(504, { 'Content-Type': 'text/plain' });
              res.end('Gateway Timeout');
            } else {
              res.destroy(); // abort cleanly — client sees truncated connection
            }
          }
        } catch {}
      });
      const MAX_BODY_BYTES = 10 * 1024 * 1024;
      let bodyBytes = 0;
      // Manual body write with backpressure — avoids dual-listener race from req.pipe + req.on('data')
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.on('data', (chunk: Buffer) => {
          if (requestFailed) return;
          requestBodyBytes += chunk.length;
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_BODY_BYTES && !requestFailed) {
            cancelTimeout?.();
            req.destroy();
            upSock.destroy();
            requestFailed = true;
            try {
              if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'text/plain' });
              if (!res.writableEnded) res.end('Payload Too Large');
            } catch {}
            return;
          }
          const ok = upSock.write(chunk);
          if (!ok) {
            req.pause();
            upSock.once('drain', () => req.resume());
          }
        });
      }

      // Read upstream response and forward — parse headers, filter hop-by-hop, pass to client
      let respBuf: Buffer = Buffer.alloc(0);
      let headerParsed = false;
      let statusCode = 0;

      upSock.on('data', (chunk: Buffer) => {
        if (requestFailed) return;

        if (!headerParsed) {
          const combined = respBuf.length > 0 ? Buffer.concat([respBuf, chunk]) : chunk;

          if (combined.length > MAX_RESPONSE_HEADER_BYTES) {
            cancelTimeout?.();
            markHttpFailure(new Error('upstream response header too large'));
            try {
              if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway');
            } catch {}
            upSock.destroy();
            return;
          }

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
            const respHeaders: Record<string, string | string[]> = {};
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i];
              const sep = line.indexOf(':');
              if (sep === -1) continue;
              const k = line.slice(0, sep).trim();
              const v = line.slice(sep + 1).trim();
              if (k && !(k.toLowerCase() in HOP_BY_HOP)) {
                const existing = respHeaders[k];
                if (existing !== undefined) {
                  respHeaders[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
                } else {
                  respHeaders[k] = v;
                }
              }
            }
            try {
              res.writeHead(statusCode, respHeaders);
              headerParsed = true;
              respBuf = Buffer.alloc(0);
              if (rest.length) {
                if (!res.write(rest)) {
                  upSock.pause();
                }
                upstreamBytes += rest.length;
              }
            } catch {}
          } else {
            respBuf = combined;
          }
        } else {
          try {
            if (!res.write(chunk)) {
              upSock.pause();
            }
          } catch {}
          upstreamBytes += chunk.length;
        }
      });
      res.on('drain', () => {
        upSock.resume();
      });

      upSock.on('end', () => {
        cancelTimeout?.();
        const totalTime = Date.now() - startTime;
        if (!requestFailed && headerParsed) {
          ctx.health.recordSuccess(upstream.raw, targetKey, dialLatency, Date.now());
          ctx.onRequestMetrics?.({ proxy: upstream.raw, target: targetKey, success: true, latency: totalTime, bytes: upstreamBytes + requestBodyBytes });
          logger.info(
            { reqId, proxy: upstream.raw, target: targetKey, statusCode, bytes: upstreamBytes + requestBodyBytes, latency: totalTime },
            'http request completed',
          );
        } else if (!requestFailed && !headerParsed) {
          markHttpFailure(new Error('upstream closed before response'));
          ctx.onRequestMetrics?.({ proxy: upstream.raw, target: targetKey, success: false, latency: totalTime, bytes: upstreamBytes + requestBodyBytes });
        }
        try {
          if (!res.writableEnded) res.end();
        } catch {}
      });

      upSock.on('error', (err: Error) => {
        cancelTimeout?.();
        const totalTime = Date.now() - startTime;
        try {
          if (!res.headersSent) res.writeHead(502);
          if (!res.writableEnded) res.end('Bad Gateway');
        } catch {}
        if (!requestFailed) {
          markHttpFailure(err);
          ctx.onRequestMetrics?.({ proxy: upstream.raw, target: targetKey, success: false, latency: totalTime, bytes: upstreamBytes + requestBodyBytes });
        }
      });
      req.on('error', () => {
        cancelTimeout?.();
        try {
          upSock.destroy();
        } catch {}
      });
      res.on('close', () => {
        cancelTimeout?.();
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
        res.end('Bad Gateway');
      } catch {}
    } finally {
      concurrentConnections--;
    }
  });
  return server;
}
