import type net from 'node:net';
import type { RotatorConfig } from '../config/index.js';
import { EventLog } from '../events.js';
import { classifyError, type HealthStore } from '../health/index.js';
import { createLogger } from '../logger.js';
import { type DialMode, dial, isForwardedDial, type ParsedProxy, parseHostPort } from './dial.js';
import { resolveTargetAddress } from './ssrf.js';
import { tlsHandshake } from './tls.js';

const logger = createLogger('rotator');
// Ports that require TLS handshake validation during health checks.
const TLS_PORTS: Record<number, true> = { 443: true, 8443: true, 4433: true, 9443: true };

// Session affinity: stick to the same proxy per target within the affinity window.
// This prevents per-request IP rotation that makes fingerprint-based correlation trivial.
const sessionAffinity = new Map<string, { raw: string; expiresAt: number }>();

function checkSessionProxy(
  targetKey: string,
  proxies: ParsedProxy[],
  health: HealthStore,
  forTarget: string | undefined,
  maxErrors: number,
  now: number,
): ParsedProxy | undefined {
  const entry = sessionAffinity.get(targetKey);
  if (!entry || now >= entry.expiresAt) {
    if (entry) sessionAffinity.delete(targetKey);
    return undefined;
  }
  const proxy = proxies.find((p) => p.raw === entry.raw);
  if (!proxy || !health.isAlive(proxy.raw, forTarget, maxErrors)) {
    sessionAffinity.delete(targetKey);
    return undefined;
  }
  return proxy;
}

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
    [top[i], top[j]] = [top[j]!, top[i]!];
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
  dialMode: DialMode = 'tunnel',
): Promise<{ sock: net.Socket; head: Buffer; upstream: ParsedProxy; latency: number; forwarded: boolean; targetAddress: string }> {
  const hostKey = tHost.includes(':') ? `[${tHost}]` : tHost;
  const targetKey = `${hostKey}:${tPort}`;
  // One DNS snapshot for the entire request, before affinity, jitter or retries.
  // Target lookup failures must never count as failures of a healthy proxy.
  const targetAddress = await resolveTargetAddress(tHost);
  const isTargetTracked = config.targets.includes(targetKey);
  const now = Date.now();

  // ── Session affinity ──────────────────────────────────────────────────────
  // If enabled, try the same proxy for the same target within the affinity window.
  // This prevents per-request IP rotation that makes fingerprint correlation trivial.
  if (config.sessionAffinityMs > 0) {
    const sticky = checkSessionProxy(targetKey, proxies, health, isTargetTracked ? targetKey : undefined, config.maxErrors, now);
    if (sticky) {
      try {
        const start = Date.now();
        const { sock, head } = await dial(sticky, tHost, tPort, config.timeout, dialMode, targetAddress);
        const latency = Date.now() - start;
        // Renew the affinity window on success
        sessionAffinity.set(targetKey, { raw: sticky.raw, expiresAt: now + config.sessionAffinityMs });
        logger.info({ proxy: sticky.raw, target: targetKey, latency, reqId, sticky: true }, 'upstream dial succeeded (sticky)');
        return { sock, head, upstream: sticky, latency, forwarded: isForwardedDial(sticky, dialMode), targetAddress };
      } catch (e: unknown) {
        // Sticky proxy failed — remove affinity, record failure, fall through
        sessionAffinity.delete(targetKey);
        health.recordFailure(sticky.raw, isTargetTracked ? targetKey : undefined, e, config, Date.now());
        const errClass = classifyError(e);
        EventLog.safePush(eventLog, {
          type: 'retry',
          proxy: sticky.raw,
          target: targetKey,
          status: 'attempt',
          error: e instanceof Error ? e.message : String(e),
          errorClass: errClass,
          detail: 'sticky proxy failed, falling through',
        });
        logger.warn(
          { proxy: sticky.raw, target: targetKey, error: e instanceof Error ? e.message : String(e), errorClass: errClass, reqId },
          'sticky proxy failed, falling through',
        );
      }
    }
  }

  // ── Pre-connect jitter ────────────────────────────────────────────────────
  // Random delay before dialing makes timing patterns less predictable.
  if (config.preConnectJitterMs > 0) {
    const jitter = Math.random() * config.preConnectJitterMs;
    if (jitter > 0) await new Promise((r) => setTimeout(r, jitter));
  }

  // ── Normal retry loop ─────────────────────────────────────────────────────
  const n = Math.max(1, config.retries);
  const candidates = pickMany(proxies, health, n, isTargetTracked ? targetKey : undefined, config.maxErrors);
  if (!candidates.length) {
    logger.warn({ target: targetKey, reqId }, 'no proxies alive');
    EventLog.safePush(eventLog, { type: 'pool', proxy: '(all)', target: targetKey, status: 'failure', error: 'no proxies alive' });
    throw new Error('no proxies alive');
  }
  logger.debug({ target: targetKey, candidates: candidates.length, reqId }, 'starting retry loop');
  let lastErr: unknown;
  let attemptNum = 0;
  for (const upstream of candidates) {
    const start = Date.now();
    try {
      const { sock, head } = await dial(upstream, tHost, tPort, config.timeout, dialMode, targetAddress);
      const latency = Date.now() - start;
      logger.info({ proxy: upstream.raw, target: targetKey, latency, reqId }, 'upstream dial succeeded');
      // Record session affinity on successful dial
      if (config.sessionAffinityMs > 0) {
        sessionAffinity.set(targetKey, { raw: upstream.raw, expiresAt: Date.now() + config.sessionAffinityMs });
      }
      return { sock, head, upstream, latency, forwarded: isForwardedDial(upstream, dialMode), targetAddress };
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
          attempt: attemptNum + 1,
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
        ...(errCode ? { errorCode: errCode } : {}),
        errorClass: errClass,
        detail: `attempt ${attemptNum + 1}/${candidates.length}`,
      });
      health.recordFailure(upstream.raw, isTargetTracked ? targetKey : undefined, e, config, Date.now());
      attemptNum++;
    }
  }
  const lastErrMsg = lastErr instanceof Error ? lastErr.message : lastErr ? String(lastErr) : 'unknown';
  logger.error({ target: targetKey, reqId, error: lastErrMsg }, 'all retries failed');
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
export async function healthCheckTick(proxies: ParsedProxy[], health: HealthStore, config: RotatorConfig, targets: string[], eventLog?: EventLog) {
  if (!targets.length) return;
  const target = targets[Math.floor(Math.random() * targets.length)];
  if (target === undefined) return;
  const parsed = parseHostPort(target, 80);
  if (!parsed) return;
  let targetAddress: string;
  try {
    targetAddress = await resolveTargetAddress(parsed.host);
  } catch (e) {
    logger.warn({ target, error: e instanceof Error ? e.message : String(e) }, 'skipping health check for invalid target');
    return;
  }
  const toCheck = pickMany(proxies, health, config.healthCheckCount, target, config.maxErrors + 10);
  logger.debug({ target, checkCount: toCheck.length }, 'health check tick');
  const checkOne = async (p: ParsedProxy) => {
    const dialStart = Date.now();
    try {
      const { sock } = await dial(p, parsed.host, parsed.port, config.timeout, 'tunnel', targetAddress);
      if (TLS_PORTS[parsed.port]) {
        try {
          const tlsRes = await tlsHandshake(sock, parsed.host, { insecure: config.validationInsecure, timeout: config.timeout });
          if (!tlsRes.authorized) {
            sock.destroy();
            if (config.validationStrictTLS) {
              throw new Error(`TLS invalid: ${tlsRes.authorizationError}`);
            }
            const errMsg = `TLS unauthorized: ${tlsRes.authorizationError}`;
            EventLog.safePush(eventLog, { type: 'healthcheck', proxy: p.raw, target, status: 'failure', error: errMsg, errorClass: 'transient' });
            logger.warn({ proxy: p.raw, target, error: errMsg }, 'health check TLS failure (non-strict)');
            health.recordFailure(p.raw, target, new Error(errMsg), config, Date.now());
            return;
          }
          sock.destroy();
        } catch (e: unknown) {
          try {
            sock.destroy();
          } catch {}
          const errMsg = e instanceof Error ? e.message : String(e);
          EventLog.safePush(eventLog, { type: 'healthcheck', proxy: p.raw, target, status: 'failure', error: errMsg, errorClass: classifyError(e) });
          logger.warn({ proxy: p.raw, target, error: errMsg, errorClass: classifyError(e) }, 'health check TLS failure');
          throw e;
        }
      } else {
        sock.destroy();
      }
      EventLog.safePush(eventLog, { type: 'healthcheck', proxy: p.raw, target, status: 'success', latency: Date.now() - dialStart });
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
        ...(errCode ? { errorCode: errCode } : {}),
        errorClass: classifyError(e),
      });
      health.recordFailure(p.raw, target, e, config, Date.now());
      logger.warn({ proxy: p.raw, target, error: errMsg, errorClass: classifyError(e) }, 'health check failure');
    }
  };

  if (config.healthCheckParallel) {
    await Promise.allSettled(toCheck.map(checkOne));
  } else {
    for (const p of toCheck) {
      await checkOne(p);
    }
  }
  // Sweep expired session-affinity entries to prevent unbounded map growth.
  if (sessionAffinity.size > 1000) {
    const now = Date.now();
    for (const [k, v] of sessionAffinity) {
      if (now >= v.expiresAt) sessionAffinity.delete(k);
    }
  }
}
