import type net from 'node:net';
import type { RotatorConfig } from '../config/index.js';
import { EventLog } from '../events.js';
import { classifyError, type HealthStore } from '../health/index.js';
import { createLogger } from '../logger.js';
import { dial, type ParsedProxy, parseHostPort } from './dial.js';
import { tlsHandshake } from './tls.js';

const logger = createLogger('rotator');

export interface PoolOptions {
  config: RotatorConfig;
  health: HealthStore;
  getProxies: () => ParsedProxy[];
}

export function pickMany(proxies: ParsedProxy[], health: HealthStore, n: number, forTarget: string | undefined, maxErrors: number): ParsedProxy[] {
  const alive = proxies.filter((p) => health.isAlive(p.raw, forTarget, maxErrors));
  if (!alive.length) return [];
  const now = Date.now();
  alive.sort((a, b) => health.scoreProxy(a.raw, forTarget, now) - health.scoreProxy(b.raw, forTarget, now));
  const poolSize = Math.min(n, alive.length);
  const top = alive.slice(0, poolSize);
  for (let i = top.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [top[i], top[j]] = [top[j], top[i]];
  }
  return top;
}
export async function tryWithRetry(
  proxies: ParsedProxy[],
  health: HealthStore,
  config: RotatorConfig,
  tHost: string,
  tPort: number,
  eventLog?: EventLog,
  reqId?: string,
): Promise<{ sock: net.Socket; head: Buffer; upstream: ParsedProxy; latency: number }> {
  const targetKey = `${tHost}:${tPort}`;
  const isTargetTracked = config.targets.includes(targetKey);
  const candidates = pickMany(proxies, health, config.retries, isTargetTracked ? targetKey : undefined, config.maxErrors);
  if (!candidates.length) {
    logger.warn({ target: targetKey, reqId }, 'no proxies alive');
    EventLog.safePush(eventLog, { type: 'pool', proxy: '(all)', target: targetKey, status: 'failure', error: 'no proxies alive' });
    throw new Error('no proxies alive');
  }
  logger.debug({ target: targetKey, candidates: candidates.length, reqId }, 'starting retry loop');
  let lastErr: unknown;
  for (const upstream of candidates) {
    const start = Date.now();
    try {
      const { sock, head } = await dial(upstream, tHost, tPort, config.timeout);
      const latency = Date.now() - start;
      health.recordSuccess(upstream.raw, isTargetTracked ? targetKey : undefined, latency, start);
      logger.info({ proxy: upstream.raw, target: targetKey, latency, reqId }, 'upstream dial succeeded');
      return { sock, head, upstream, latency };
    } catch (e: unknown) {
      lastErr = e;
      const errClass = classifyError(e);
      const errMsg = e instanceof Error ? e.message : String(e);
      const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
      logger.warn(
        {
          proxy: upstream.raw,
          target: targetKey,
          error: errMsg,
          errorClass: errClass,
          attempt: candidates.indexOf(upstream) + 1,
          total: candidates.length,
          reqId,
        },
        'retry attempt failed',
      );
      EventLog.safePush(eventLog, {
        type: 'retry',
        proxy: upstream.raw,
        target: targetKey,
        status: 'attempt',
        error: errMsg,
        errorCode: errCode,
        errorClass: errClass,
        detail: `attempt ${candidates.indexOf(upstream) + 1}/${candidates.length}`,
      });
      health.recordFailure(upstream.raw, isTargetTracked ? targetKey : undefined, e, config, Date.now());
    }
  }
  const lastErrMsg = lastErr instanceof Error ? lastErr.message : lastErr ? String(lastErr) : 'unknown';
  logger.error({ target: targetKey, reqId, error: lastErrMsg }, 'all retries failed');
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
export async function healthCheckTick(proxies: ParsedProxy[], health: HealthStore, config: RotatorConfig, targets: string[], eventLog?: EventLog) {
  if (!targets.length) return;
  const target = targets[Math.floor(Math.random() * targets.length)];
  const parsed = parseHostPort(target, 80);
  if (!parsed) return;
  const toCheck = pickMany(proxies, health, 10, target, config.maxErrors + 10);
  logger.debug({ target, checkCount: toCheck.length }, 'health check tick');
  await Promise.allSettled(
    toCheck.map(async (p) => {
      const dialStart = Date.now();
      EventLog.safePush(eventLog, { type: 'healthcheck', proxy: p.raw, target, status: 'attempt' });
      try {
        const { sock } = await dial(p, parsed.host, parsed.port, config.timeout);
        if (parsed.port === 443) {
          try {
            const tlsRes = await tlsHandshake(sock, parsed.host, { insecure: !config.validationStrictTLS, timeout: config.timeout });
            if (config.validationStrictTLS && !tlsRes.authorized) {
              throw new Error(`TLS invalid: ${tlsRes.authorizationError}`);
            }
            sock.destroy();
          } catch (e: unknown) {
            try {
              sock.destroy();
            } catch {}
            const errMsg = e instanceof Error ? e.message : String(e);
            EventLog.safePush(eventLog, {
              type: 'healthcheck',
              proxy: p.raw,
              target,
              status: 'failure',
              error: errMsg,
              errorClass: classifyError(e),
            });
            logger.warn({ proxy: p.raw, target, error: errMsg, errorClass: classifyError(e) }, 'health check TLS failure');
            throw e;
          }
        } else {
          sock.destroy();
        }
        EventLog.safePush(eventLog, {
          type: 'healthcheck',
          proxy: p.raw,
          target,
          status: 'success',
          latency: Date.now() - dialStart,
        });
        health.recordSuccess(p.raw, target, Date.now() - dialStart, dialStart);
        logger.debug({ proxy: p.raw, target, latency: Date.now() - dialStart }, 'health check success');
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const errCode = e != null && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
        EventLog.safePush(eventLog, {
          type: 'healthcheck',
          proxy: p.raw,
          target,
          status: 'failure',
          error: errMsg,
          errorCode: errCode,
          errorClass: classifyError(e),
        });
        health.recordFailure(p.raw, target, e, config, Date.now());
        logger.warn({ proxy: p.raw, target, error: errMsg, errorClass: classifyError(e) }, 'health check failure');
      }
    }),
  );
}
