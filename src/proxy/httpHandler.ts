// HTTP GET/POST handler for the proxy server.
// Extracted from server.ts for independent testability.

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RotatorConfig } from '../config/index.js';
import { EventLog } from '../events.js';
import { classifyError, type HealthStore } from '../health/index.js';
import { createLogger } from '../logger.js';
import type { ConnectionTracker } from './connectHandler.js';
import type { ParsedProxy } from './dial.js';
import { createChunkedBodyDecoder, type ParsedResponse, parseResponseHeaders, STRIPPED_REQUEST_HEADERS } from './responseParser.js';
import { tryWithRetry } from './rotator.js';
import { isBlockedTarget } from './ssrf.js';
import { startSocketTimeout } from './timeout.js';

const logger = createLogger('proxy');

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface HttpHandlerCtx {
  config: { current: RotatorConfig };
  health: HealthStore;
  getProxies: () => ParsedProxy[];
  onRequestMetrics?: (info: { proxy: string; target: string; success: boolean; latency: number; bytes: number }) => void;
  eventLog?: EventLog;
  connections: ConnectionTracker;
}

export function handleHttp(ctx: HttpHandlerCtx, req: IncomingMessage, res: ServerResponse): void {
  const reqId = crypto.randomBytes(4).toString('hex');
  let cancelTimeout: (() => void) | undefined;
  const el = ctx.eventLog;
  let targetKey = '';
  const conn = ctx.connections;
  if (conn.count >= conn.max) {
    conn.rejected++;
    try {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Service Unavailable');
    } catch {}
    return;
  }
  conn.count++;
  // A response may outlive this synchronous handler by minutes. Keep the slot
  // reserved until completion or client disconnect, including on error paths.
  res.once('close', () => {
    conn.count--;
  });
  try {
    let targetUrl: URL;
    try {
      targetUrl = new URL(req.url ?? '/');
      if (!targetUrl.hostname) throw new Error('relative URL');
    } catch {
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
    // Plain-HTTP targets are forwarded with an absolute-URI request line
    // (no CONNECT) — README "forwards plain HTTP via GET". HTTPS targets
    // always tunnel so TLS terminates end-to-end.
    const dialMode = targetUrl.protocol === 'http:' ? 'forward' : 'tunnel';
    tryWithRetry(proxies, ctx.health, config, tHost, tPort, el, reqId, dialMode)
      .then(({ sock: upSock, head: upHead, upstream, latency: dialLatency, forwarded, targetAddress }) => {
        if (res.destroyed || res.writableEnded) {
          upSock.destroy();
          return;
        }
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
            bytes: upstreamBytes + requestBodyBytes,
          });
        };
        if (upHead?.length) {
          markHttpFailure(new Error('upstream sent data before response'));
          upSock.destroy();
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
          return;
        }

        // Send request to upstream — preserve original header casing via rawHeaders
        const pathAndQuery = targetUrl.pathname + targetUrl.search;
        const requestTransferEncoding = req.headers['transfer-encoding'];
        let reqHeaderLines = '';
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i].replace(/[\r\n]/g, '').trim();
          if (k.toLowerCase() === 'host' || k.toLowerCase() in STRIPPED_REQUEST_HEADERS) continue;
          const v = req.rawHeaders[i + 1].replace(/[\r\n]/g, '').trim();
          reqHeaderLines += `${k}: ${v}\r\n`;
        }
        if (requestTransferEncoding) reqHeaderLines += `Transfer-Encoding: ${requestTransferEncoding}\r\n`;
        let proxyAuthLine = '';
        if (forwarded && upstream.url.username) {
          const token = Buffer.from(`${upstream.url.username}:${upstream.url.password}`).toString('base64');
          proxyAuthLine = `Proxy-Authorization: Basic ${token}\r\n`;
        }
        // Forwarded (plain-HTTP) requests use the absolute URI; tunnelled
        // requests go through the CONNECT tunnel with origin-form.
        const dialAuthority = `${targetAddress.includes(':') ? `[${targetAddress}]` : targetAddress}:${tPort}`;
        const requestTarget = forwarded ? `http://${dialAuthority}${pathAndQuery}` : pathAndQuery;
        const reqLine = `${req.method} ${requestTarget} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n${reqHeaderLines}${proxyAuthLine}Connection: close\r\n\r\n`;
        upSock.write(reqLine);
        cancelTimeout = startSocketTimeout([upSock, req.socket], Math.max(config.timeout, 15000), config.upstreamIdleTimeout || config.timeout * 2, () => {
          if (requestFailed) return;
          requestFailed = true;
          ctx.health.recordFailure(upstream.raw, targetKey, { message: 'upstream timeout' }, config);
          logger.warn({ reqId, proxy: upstream.raw, target: targetKey }, 'upstream timeout');
          EventLog.safePush(el, {
            type: 'http',
            proxy: upstream.raw,
            target: targetKey,
            status: 'failure',
            error: 'upstream timeout',
            errorClass: 'transient',
          });
          upSock.destroy();
          try {
            if (!res.writableEnded) {
              if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'text/plain' });
                res.end('Gateway Timeout');
              } else {
                res.destroy();
              }
            }
          } catch {}
        });
        let bodyBytes = 0;
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
            if (requestTransferEncoding) upSock.write(`${chunk.length.toString(16)}\r\n`);
            const ok = upSock.write(chunk);
            if (requestTransferEncoding) upSock.write('\r\n');
            if (!ok) {
              req.pause();
              upSock.once('drain', () => req.resume());
            }
          });
          req.on('end', () => {
            if (requestTransferEncoding && !requestFailed) upSock.write('0\r\n\r\n');
          });
        }

        let respBuf: Buffer = Buffer.alloc(0);
        let headerParsed = false;
        let statusCode = 0;
        let upstreamResponseFailed = false;
        let responseIsChunked = false;
        let chunkedBodyDecoder: ReturnType<typeof createChunkedBodyDecoder> | undefined;
        let responseHasNoBody = false;
        const writeResponseBody = (body: Buffer) => {
          if (!body.length) return;
          if (!res.write(body)) upSock.pause();
          upstreamBytes += body.length;
        };
        const failChunkedResponse = (message: string) => {
          cancelTimeout?.();
          markHttpFailure(new Error(message));
          ctx.onRequestMetrics?.({
            proxy: upstream.raw,
            target: targetKey,
            success: false,
            latency: Date.now() - startTime,
            bytes: upstreamBytes + requestBodyBytes,
          });
          try {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'text/plain' });
              res.end('Bad Gateway');
            } else {
              res.destroy();
            }
          } catch {}
          upSock.destroy();
        };
        upSock.on('data', (chunk: Buffer) => {
          if (requestFailed) return;

          if (!headerParsed) {
            const combined = respBuf.length > 0 ? Buffer.concat([respBuf, chunk]) : chunk;

            let parsed: ParsedResponse | null;
            try {
              parsed = parseResponseHeaders(combined);
            } catch (e) {
              cancelTimeout?.();
              markHttpFailure(e instanceof Error ? e : new Error(String(e)));
              try {
                if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway');
              } catch {}
              upSock.destroy();
              return;
            }

            if (parsed === null) {
              respBuf = combined;
              return;
            }

            statusCode = parsed.statusCode;

            if (statusCode >= 500 && !requestFailed) {
              upstreamResponseFailed = true;
              EventLog.safePush(el, {
                type: 'http',
                proxy: upstream.raw,
                target: targetKey,
                status: 'failure',
                error: `upstream ${statusCode}`,
                errorClass: 'transient',
              });
              ctx.health.recordFailure(upstream.raw, targetKey, { message: `upstream ${statusCode}` }, config);
            }

            try {
              res.writeHead(statusCode, parsed.headers);
              headerParsed = true;
              respBuf = Buffer.alloc(0);
              responseHasNoBody = req.method === 'HEAD' || statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200);
              responseIsChunked = parsed.isChunked && !responseHasNoBody;
              if (responseIsChunked) chunkedBodyDecoder = createChunkedBodyDecoder(writeResponseBody);
              if (!responseHasNoBody && !responseIsChunked) writeResponseBody(parsed.body);
              const bodyAccepted = responseIsChunked ? chunkedBodyDecoder!.write(parsed.body) : true;
              if (!bodyAccepted) {
                failChunkedResponse('malformed chunked upstream response');
                return;
              }
            } catch {
              cancelTimeout?.();
              markHttpFailure(new Error('failed to write response headers'));
              try {
                upSock.destroy();
              } catch {}
              return;
            }
          } else {
            if (responseHasNoBody) return;
            try {
              if (responseIsChunked) {
                if (!chunkedBodyDecoder!.write(chunk)) {
                  failChunkedResponse('malformed chunked upstream response');
                  return;
                }
              } else {
                writeResponseBody(chunk);
              }
            } catch {
              if (responseIsChunked) failChunkedResponse('failed to decode chunked upstream response');
            }
          }
        });
        res.on('drain', () => {
          upSock.resume();
        });

        upSock.on('end', () => {
          cancelTimeout?.();
          if (responseIsChunked && !chunkedBodyDecoder!.end()) {
            failChunkedResponse('truncated chunked upstream response');
            return;
          }
          const totalTime = Date.now() - startTime;
          if (!requestFailed && headerParsed) {
            if (!upstreamResponseFailed) {
              ctx.health.recordSuccess(upstream.raw, targetKey, dialLatency, Date.now());
            }
            ctx.onRequestMetrics?.({
              proxy: upstream.raw,
              target: targetKey,
              success: !upstreamResponseFailed,
              latency: totalTime,
              bytes: upstreamBytes + requestBodyBytes,
            });
            logger.info(
              { reqId, proxy: upstream.raw, target: targetKey, statusCode, bytes: upstreamBytes + requestBodyBytes, latency: totalTime },
              'http request completed',
            );
            requestFailed = true;
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
          requestFailed = true;
          try {
            upSock.destroy();
          } catch {}
        });
      })
      .catch((e: unknown) => {
        if (cancelTimeout) cancelTimeout();
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes('blocked by SSRF')) {
          try {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
          } catch {}
          return;
        }
        const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
        logger.error({ reqId, target: targetKey, error: errMsg }, 'http all retries failed');
        EventLog.safePush(el, { type: 'http', proxy: '(all)', target: targetKey, status: 'failure', error: errMsg, errorCode: errCode });
        try {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway');
        } catch {}
      });
  } catch (e: unknown) {
    if (cancelTimeout) cancelTimeout();
    const errMsg = e instanceof Error ? e.message : String(e);
    if (errMsg.includes('blocked by SSRF')) {
      try {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      } catch {}
      return;
    }
    const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
    logger.error({ reqId, target: targetKey, error: errMsg }, 'http all retries failed');
    EventLog.safePush(el, { type: 'http', proxy: '(all)', target: targetKey, status: 'failure', error: errMsg, errorCode: errCode });
    try {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    } catch {}
  }
}
