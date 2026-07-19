import type net from 'node:net';
import type { RotatorConfig } from '../config/index.js';
import { EventLog } from '../events.js';
import { classifyError, type HealthStore } from '../health/index.js';
import { dial, type ParsedProxy, parseHostPort } from './dial.js';
import { tlsHandshake } from './tls.js';

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
  _forTarget?: string,
  eventLog?: EventLog,
): Promise<{ sock: net.Socket; head: Buffer; upstream: ParsedProxy; latency: number }> {
  const targetKey = `${tHost}:${tPort}`;
  const isTargetTracked = config.targets.includes(targetKey);
  const candidates = pickMany(proxies, health, config.retries, isTargetTracked ? targetKey : undefined, config.maxErrors + 5);
  if (!candidates.length) {
    // LOG: no proxies alive
    EventLog.safePush(eventLog, { type: 'pool', proxy: '(all)', target: targetKey, status: 'failure', error: 'no proxies alive' });
    throw new Error('no proxies alive');
  }
  let lastErr: any;
  for (const upstream of candidates) {
    const start = Date.now();
    try {
      const { sock, head } = await dial(upstream, tHost, tPort, config.timeout);
      const latency = Date.now() - start;
      health.recordSuccess(upstream.raw, isTargetTracked ? targetKey : undefined, latency, start);
      return { sock, head, upstream, latency };
    } catch (e: any) {
      lastErr = e;
      // LOG: retry attempt
      EventLog.safePush(eventLog, {
        type: 'retry',
        proxy: upstream.raw,
        target: targetKey,
        status: 'attempt',
        error: e?.message,
        errorCode: e?.code,
        errorClass: classifyError(e),
        detail: `attempt ${candidates.indexOf(upstream) + 1}/${candidates.length}`,
      });
      health.recordFailure(upstream.raw, isTargetTracked ? targetKey : undefined, e, config, Date.now());
    }
  }
  throw lastErr || new Error('all retries failed');
}

export async function healthCheckTick(proxies: ParsedProxy[], health: HealthStore, config: RotatorConfig, targets: string[], eventLog?: EventLog) {
  if (!targets.length) return;
  const target = targets[Math.floor(Math.random() * targets.length)];
  const parsed = parseHostPort(target, 80);
  if (!parsed) return;
  const toCheck = pickMany(proxies, health, 10, target, config.maxErrors + 10);
  await Promise.allSettled(
    toCheck.map(async (p) => {
      const dialStart = Date.now();
      // LOG: healthcheck attempt
      EventLog.safePush(eventLog, { type: 'healthcheck', proxy: p.raw, target, status: 'attempt' });
      try {
        const { sock } = await dial(p, parsed.host, parsed.port, config.timeout);
        // If target is TLS (443), handshake to validate cert chain if strictTLS is on
        if (parsed.port === 443) {
          try {
            const tlsRes = await tlsHandshake(sock, parsed.host, { insecure: !config.validationStrictTLS, timeout: config.timeout });
            // If strictTLS=true and cert is invalid, treat as a failure
            if (config.validationStrictTLS && !tlsRes.authorized) {
              throw new Error(`TLS invalid: ${tlsRes.authorizationError}`);
            }
            sock.destroy();
          } catch (e: any) {
            // If handshake fails, mark as a light error
            try {
              sock.destroy();
            } catch {}
            // LOG: healthcheck TLS failure
            EventLog.safePush(eventLog, {
              type: 'healthcheck',
              proxy: p.raw,
              target,
              status: 'failure',
              error: e?.message,
              errorClass: classifyError(e),
            });
            throw e;
          }
        } else {
          // For HTTP, destroy the socket on success
          sock.destroy();
        }
        // LOG: healthcheck success
        EventLog.safePush(eventLog, {
          type: 'healthcheck',
          proxy: p.raw,
          target,
          status: 'success',
          latency: Date.now() - dialStart,
        });
        health.recordSuccess(p.raw, target, Date.now() - dialStart, dialStart);
      } catch (e: any) {
        // LOG: healthcheck failure
        EventLog.safePush(eventLog, {
          type: 'healthcheck',
          proxy: p.raw,
          target,
          status: 'failure',
          error: e?.message,
          errorCode: e?.code,
          errorClass: classifyError(e),
        });
        health.recordFailure(p.raw, target, e, config, Date.now());
      }
    }),
  );
}
