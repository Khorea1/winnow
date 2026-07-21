// --- Error classification: fatal (proxy structurally dead) vs transient (flaky) ---
// Fatal: the proxy itself is non-functional -- connection refused, TLS/cert failure,
// DNS failure, SOCKS protocol error. These are unlikely to recover on retry.
// Transient: the proxy is reachable but flaky -- timeout, upstream 5xx, early close,
// connection reset during data transfer. Retry has a chance of success.

const FATAL_ERR_CODES = new Set([
  'ECONNREFUSED', // TCP connect refused -- proxy down or wrong port
  'EADDRNOTAVAIL',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'ENOTFOUND', // DNS resolution failure for the proxy host
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_DECRYPTION_FAILED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_TLS_INVALID_PROTOCOL_METHOD',
  'EPROTO', // generic TLS protocol error
]);
// Error message fragments that mark an error as fatal when err.code is missing.
// Only patterns NOT covered by FATAL_ERR_CODES are kept: TLS/SSL errors,
// certificate issues, handshake failures, SOCKS protocol mentions, and
// generic protocol errors often lack a standard err.code.
const FATAL_MSG_REGEX = /\b(?:TLS|SSL|certificate|self[- ]?signed|handshake|SOCKS|protocol error)/i;
// SOCKSv5 reply codes indicating the proxy itself rejected the request.
const SOCKS_FATAL_REPLIES = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x07, 0x08]);
// Maximum number of failures before exponential ban plateaus.
const TRANSIENT_BAN_CAP = 6;

export function classifyError(e: unknown): 'fatal' | 'transient' {
  if (!e || typeof e !== 'object') return 'transient';
  const err = e as Record<string, unknown>;
  const code = String(err.code ?? '');
  if (code && FATAL_ERR_CODES.has(code)) return 'fatal';
  // SOCKSv5 reply-code attached by socks5Connect when the proxy returned an error
  if (typeof err.socksReply === 'number' && SOCKS_FATAL_REPLIES.has(err.socksReply)) return 'fatal';
  if (typeof err.socksReply === 'number' && !SOCKS_FATAL_REPLIES.has(err.socksReply)) return 'transient';
  const msg = String(err.message ?? '');
  if (msg) {
    if (FATAL_MSG_REGEX.test(msg)) return 'fatal';
  }
  return 'transient';
}

// ── Failure/success helpers (used by rotator.ts, server.ts, HealthStore) ──

export function transientBanMs(errors: number, banBaseMs: number, banMultiplier: number, banMaxMs: number): number {
  const k = Math.max(0, Math.min(errors - 1, TRANSIENT_BAN_CAP));
  const mult = banMultiplier ** k;
  if (!Number.isFinite(mult)) return banMaxMs;
  const raw = banBaseMs * mult;
  if (!Number.isSafeInteger(raw) || raw > banMaxMs) return banMaxMs;
  return Math.min(raw, banMaxMs);
}

export interface HealthEntry {
  errors: number;
  successes: number;
  latency: number;
  bannedUntil: number;
  lastOk: number;
  fatalErrors: number;
  frozenUntil: number;
}

export function applyFailure(
  h: HealthEntry,
  e: unknown,
  config: { maxFatalErrors: number; fatalBanMs: number; banBaseMs: number; banMultiplier: number; banMaxMs: number },
  now: number,
  preclassified?: 'fatal' | 'transient',
) {
  const cls = preclassified ?? classifyError(e);
  if (cls === 'fatal') {
    if (h.fatalErrors < config.maxFatalErrors) h.fatalErrors++;
    if (h.fatalErrors >= config.maxFatalErrors) {
      h.frozenUntil = Math.max(h.frozenUntil, now + config.fatalBanMs * 3);
    } else {
      h.bannedUntil = Math.max(h.bannedUntil, now + config.fatalBanMs);
    }
  } else {
    h.errors = Math.min(h.errors + 1, 1000);
    h.bannedUntil = now + transientBanMs(h.errors, config.banBaseMs, config.banMultiplier, config.banMaxMs);
  }
}

/**
 * Record a success. Decrements errors, updates latency EMA, clears bannedUntil.
 * Does NOT reset frozenUntil — only the boot-time prune pass in HealthStore unfreezes proxies.
 */
export function applySuccess(h: HealthEntry, latency: number, now: number) {
  const clampedLatency = latency < 0 ? h.latency : Math.min(latency, 30000);
  h.latency = h.latency === 9999 ? clampedLatency : Math.floor(h.latency * 0.7 + clampedLatency * 0.3);
  h.successes = Math.min(h.successes + 1, 200);
  h.errors = Math.max(0, h.errors - 1);
  h.fatalErrors = Math.max(0, h.fatalErrors - 1);
  h.bannedUntil = 0;
  h.lastOk = now;
}
