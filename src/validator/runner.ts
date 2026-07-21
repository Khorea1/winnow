import { createLogger } from '../logger.js';
import { httpCheck } from './checks/http.js';
import { streamingCheck } from './checks/streaming.js';
import { parseProxyForTcp, tcpCheck } from './checks/tcp.js';
import { tlsCheck } from './checks/tls.js';
import type { ProgressCallback, ProxyResult, ValidatorOptions } from './types.js';

const logger = createLogger('validator-runner');

/** Build a failure result consistently across all validation stages. */
function fail(proxy: string, stage: string, error: string, extra?: Partial<ProxyResult>): ProxyResult {
  return { proxy, valid: false, error, stage, ...extra };
}
// Helper: race a promise against an abort signal
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  ]);
}

export async function validateSingleProxy(proxyRaw: string, opts: ValidatorOptions, abortSignal?: AbortSignal): Promise<ProxyResult> {
  const trimmed = proxyRaw.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return fail(proxyRaw, 'parse', 'empty line');
  }

  // Stage TCP
  const tcpInfo = parseProxyForTcp(trimmed);
  if (!tcpInfo) {
    return fail(trimmed, 'parse', 'invalid format');
  }

  try {
    await tcpCheck(tcpInfo.host, tcpInfo.port, opts.connectTimeout * 1000);
  } catch {
    return fail(trimmed, 'tcp', 'TCP unreachable', { httpCode: 0 });
  }

  if (abortSignal?.aborted) return fail(trimmed, 'cancelled', 'aborted');

  // Stage A - HTTP /ip
  if (opts.mode !== 'tcp-only') {
    try {
      const target = `${opts.baseUrl.replace(/\/$/, '')}/ip`;
      const res = await withAbort(
        httpCheck(trimmed, target, {
          connectTimeout: opts.connectTimeout,
          maxLatency: opts.maxLatency,
          insecure: opts.insecure,
          strictTLS: opts.strictTLS,
          anonCheck: opts.anonCheck,
        }),
        abortSignal,
      );

      if (res.status !== 200 && res.status !== 0) {
        return fail(trimmed, 'http', `HTTP ${res.status}`, { httpCode: res.status, latency: res.latency });
      }

      if (res.latency > opts.maxLatency) {
        return fail(trimmed, 'http', `latency ${res.latency}ms > ${opts.maxLatency}ms`, { httpCode: res.status, latency: res.latency });
      }

      // Only enforce 'origin' body content check if using httpbin.
      // Custom baseUrls just need a 200 OK within the latency budget.
      const isHttpbin = opts.baseUrl.includes('httpbin.org');
      if (isHttpbin && !res.body.includes('origin')) {
        return fail(trimmed, 'http', 'invalid content', { httpCode: res.status, latency: res.latency });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('transparent')) {
        return fail(trimmed, 'http', 'transparent proxy');
      }
      if (msg.includes('TLS invalid') || msg.includes('self-signed')) {
        return fail(trimmed, 'tls', msg);
      }
      return fail(trimmed, 'http', msg);
    }
  }
  if (abortSignal?.aborted) return fail(trimmed, 'cancelled', 'aborted');

  // Stage TLS explicit - check self-signed if strictTLS=true
  if (opts.strictTLS) {
    try {
      const tlsHost = opts.tlsHost || 'www.google.com';
      const tlsPort = opts.tlsPort || 443;
      const tlsRes = await withAbort(
        tlsCheck(trimmed, tlsHost, tlsPort, {
          connectTimeout: opts.connectTimeout,
          insecure: false,
          strictTLS: true,
        }),
        abortSignal,
      );
      if (!tlsRes.authorized) {
        return fail(trimmed, 'tls', `TLS invalid: ${tlsRes.error}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('TLS invalid') || msg.includes('self-signed') || msg.includes('certificate')) {
        return fail(trimmed, 'tls', msg);
      }
      // Any other error (timeout, network) means TLS check failed
      return fail(trimmed, 'tls', `TLS check failed: ${msg}`);
    }
  }

  if (abortSignal?.aborted) return fail(trimmed, 'cancelled', 'aborted');

  // Stage B - light streaming
  if (opts.mode === 'standard' || opts.mode === 'strict' || opts.mode === 'stream') {
    try {
      const streamUrl = `${opts.baseUrl.replace(/\/$/, '')}/stream/5?delay=0.2`;
      const res = await withAbort(
        streamingCheck(trimmed, streamUrl, {
          connectTimeout: opts.connectTimeout,
          maxTime: 25,
          expectedChunks: 5,
          ttfbRatio: opts.ttfbRatio,
          maxGap: opts.maxGap,
        }),
        abortSignal,
      );
      const minChunks = Math.max(1, Math.floor(5 * 0.5));
      if (res.chunks < minChunks) {
        return fail(trimmed, 'stream', `insufficient chunks ${res.chunks}/5`, { chunks: res.chunks, ttfb: res.ttfb });
      }
    } catch (e: unknown) {
      return fail(trimmed, 'stream', e instanceof Error ? e.message : String(e));
    }
  }

  if (abortSignal?.aborted) return fail(trimmed, 'cancelled', 'aborted');

  // Stage D - streaming 20 + POST para strict
  if (opts.mode === 'strict') {
    try {
      const stream20Url = `${opts.baseUrl.replace(/\/$/, '')}/stream/20?delay=0.1`;
      const res = await withAbort(
        streamingCheck(trimmed, stream20Url, {
          connectTimeout: opts.connectTimeout,
          maxTime: 35,
          expectedChunks: 20,
          ttfbRatio: opts.ttfbRatio,
          maxGap: opts.maxGap,
        }),
        abortSignal,
      );
      if (res.chunks < 10) {
        return fail(trimmed, 'stream20', `insufficient chunks ${res.chunks}/20`, { chunks: res.chunks });
      }
    } catch (e: unknown) {
      return fail(trimmed, 'stream20', e instanceof Error ? e.message : String(e));
    }
  }

  return { proxy: trimmed, valid: true, stage: 'ok' };
}

export async function runValidation(
  proxyList: string[],
  opts: ValidatorOptions,
  onProgress?: ProgressCallback,
  abortSignal?: AbortSignal,
): Promise<{ valid: string[]; invalid: { proxy: string; reason: string }[]; results: ProxyResult[] }> {
  const valid: string[] = [];
  const invalid: { proxy: string; reason: string }[] = [];
  const results: ProxyResult[] = [];
  const total = proxyList.length;
  let done = 0;
  // Flat worker pool: each worker pulls from a shared queue
  const queue = proxyList;
  let idx = 0;
  let workerCount = Math.min(opts.threads, queue.length);
  if (workerCount < 1) {
    logger.warn({}, 'thread count is 0, defaulting to 1');
    workerCount = 1;
  }

  async function worker() {
    try {
      while (idx < queue.length && !abortSignal?.aborted) {
        const proxy = queue[idx++];

        if (opts.throttle > 0) {
          await new Promise((r) => setTimeout(r, opts.throttle));
        }
        if (abortSignal?.aborted) break;

        try {
          const res = await validateSingleProxy(proxy, opts, abortSignal);
          results.push(res);
          if (res.valid) valid.push(res.proxy);
          else invalid.push({ proxy: res.proxy, reason: res.error || 'error' });
          done++;
          onProgress?.(res, { total, done, valid: valid.length, invalid: invalid.length });
          const sanitizedProxy = res.proxy.replace(/\/\/.*@/, '//***:***@');
          logger.debug(
            {
              proxy: sanitizedProxy,
              valid: res.valid,
              stage: res.stage,
              error: res.error,
              done,
              total,
              validCount: valid.length,
              invalidCount: invalid.length,
            },
            'validation result',
          );
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          const r: ProxyResult = { proxy, valid: false, error: errMsg, stage: 'unknown' };
          results.push(r);
          invalid.push({ proxy, reason: r.error! });
          done++;
          onProgress?.(r, { total, done, valid: valid.length, invalid: invalid.length });
          const sanitizedProxy = r.proxy.replace(/\/\/.*@/, '//***:***@');
          logger.debug(
            { proxy: sanitizedProxy, valid: false, stage: r.stage, error: r.error, done, total, validCount: valid.length, invalidCount: invalid.length },
            'validation error',
          );
        }
      }
    } catch (e) {
      logger.error({ error: e instanceof Error ? e.message : String(e) }, 'validation worker error');
    }
  }

  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  return { valid, invalid, results };
}
