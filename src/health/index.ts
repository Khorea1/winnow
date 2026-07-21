import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';

import { type HealthRowInput, insertHealth, loadHealth, removeProxyHealth } from '../db/index.js';
import { EventLog } from '../events.js';
import { createLogger } from '../logger.js';

const logger = createLogger('health');

export interface HealthEntry {
  errors: number;
  successes: number;
  latency: number;
  bannedUntil: number;
  lastOk: number;
  fatalErrors: number;
  frozenUntil: number;
}

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
const FATAL_MSG_REGEX = /\b(?:TLS|SSL|certificate|self[- ]?signed|handshake|SOCKS|protocol error)\b/i;
// SOCKSv5 reply codes indicating the proxy itself rejected the request.
const SOCKS_FATAL_REPLIES = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x07, 0x08]);

export function classifyError(e: unknown): 'fatal' | 'transient' {
  if (!e || typeof e !== 'object') return 'transient';
  const err = e as Record<string, unknown>;
  const code = String(err.code ?? err.errno ?? '');
  if (code && FATAL_ERR_CODES.has(code)) return 'fatal';
  // SOCKSv5 reply-code attached by socks5Connect when the proxy returned an error
  if (typeof err.socksReply === 'number' && SOCKS_FATAL_REPLIES.has(err.socksReply)) return 'fatal';
  const msg = String(err.message ?? '');
  if (msg) {
    if (FATAL_MSG_REGEX.test(msg)) return 'fatal';
  }
  return 'transient';
}
// ── Shared helpers (used by rotator.ts and server.ts) ──────────────────────

export function transientBanMs(errors: number, banBaseMs: number, banMultiplier: number, banMaxMs: number): number {
  const k = Math.max(0, Math.min(errors - 1, 6));
  const raw = banBaseMs * banMultiplier ** k;
  return Math.min(raw, banMaxMs);
}

export function applyFailure(
  h: HealthEntry,
  e: unknown,
  config: { maxFatalErrors: number; fatalBanMs: number; banBaseMs: number; banMultiplier: number; banMaxMs: number },
  now: number,
) {
  if (classifyError(e) === 'fatal') {
    h.fatalErrors++;
    if (h.fatalErrors >= config.maxFatalErrors) {
      h.frozenUntil = now + config.fatalBanMs * 3;
    } else {
      h.bannedUntil = now + config.fatalBanMs;
    }
  } else {
    h.errors++;
    h.bannedUntil = now + transientBanMs(h.errors, config.banBaseMs, config.banMultiplier, config.banMaxMs);
  }
}
/**
 * Record a success. Decrements errors, updates latency EMA, clears bannedUntil.
 * Does NOT reset fatalErrors or frozenUntil — only the boot-time prune pass
 * in HealthStore unfreezes proxies.
 */
export function applySuccess(h: HealthEntry, latency: number, now: number) {
  h.latency = h.latency === 9999 ? latency : Math.floor(h.latency * 0.7 + latency * 0.3);
  h.successes++;
  h.errors = Math.max(0, h.errors - 1);
  h.bannedUntil = 0;
  h.lastOk = now;
}

export function ensureStarEntry(health: HealthStore, proxy: string): HealthEntry {
  let h = health.get(proxy);
  if (!h) {
    h = blankEntry();
    health.set(proxy, h);
  }
  return h;
}

export function blankEntry(): HealthEntry {
  return { errors: 0, successes: 0, latency: 9999, bannedUntil: 0, lastOk: 0, fatalErrors: 0, frozenUntil: 0 };
}

export class HealthStore extends EventEmitter {
  private db: Database.Database;
  private _data: Map<string, Map<string, HealthEntry>> = new Map();
  private _dirty: Set<string> = new Set();
  private _deleted: Set<string> = new Set();
  private _timer: NodeJS.Timeout;
  private _eventLog?: EventLog;

  constructor(db: Database.Database, config: { pruneAfterMs: number; fatalBanMs: number }, eventLog?: EventLog) {
    super();
    this.db = db;
    this._eventLog = eventLog;
    this._load();
    this._pruneFrozenOnBoot(config.pruneAfterMs, config.fatalBanMs);
    this._timer = setInterval(() => this._flush(), 5000);
    this._timer.unref();
  }
  get(proxy: string): HealthEntry | undefined {
    return this._data.get(proxy)?.get('*');
  }

  set(proxy: string, val: HealthEntry) {
    let byTarget = this._data.get(proxy);
    if (!byTarget) {
      byTarget = new Map();
      this._data.set(proxy, byTarget);
    }
    byTarget.set('*', val);
    this._dirty.add(`${proxy}\x00*`);
  }

  has(proxy: string) {
    return this._data.has(proxy);
  }
  keys() {
    return this._data.keys();
  }
  get size() {
    return this._data.size;
  }

  delete(proxy: string) {
    this._data.delete(proxy);
    this._deleted.add(proxy);
  }

  dirty(proxy: string) {
    this._dirty.add(`${proxy}\x00*`);
    this.emit('health:update', { proxy, target: '*', time: Date.now() });
  }

  getTarget(proxy: string, target: string) {
    return this._data.get(proxy)?.get(target);
  }

  setTarget(proxy: string, target: string, val: HealthEntry) {
    let byTarget = this._data.get(proxy);
    if (!byTarget) {
      byTarget = new Map();
      this._data.set(proxy, byTarget);
    }
    byTarget.set(target, val);
    this._dirty.add(`${proxy}\x00${target}`);
  }

  dirtyTarget(proxy: string, target: string) {
    this._dirty.add(`${proxy}\x00${target}`);
    this.emit('health:update', { proxy, target, time: Date.now() });
  }
  /**
   * Record a success. Updates the per-target entry (if target given) AND the
   * `*` aggregate, mirroring the failure path's two-entry update. When target
   * is undefined, only the `*` aggregate is touched.
   */
  recordSuccess(proxy: string, target: string | undefined, latency: number, now = Date.now()) {
    const star = ensureStarEntry(this, proxy);
    applySuccess(star, latency, now);
    if (target) {
      const te = this.getTarget(proxy, target);
      if (te) {
        applySuccess(te, latency, now);
        this.dirtyTarget(proxy, target);
      } else {
        const ne = blankEntry();
        ne.successes = 1;
        ne.latency = latency;
        ne.lastOk = now;
        this.setTarget(proxy, target, ne);
        this.dirtyTarget(proxy, target);
      }
    }
    this.dirty(proxy);
  }

  /**
   * Record a failure. When target is given, updates BOTH the per-target entry
   * AND the `*` aggregate (matches the old explicit ensureStarEntry+applyFailure pattern).
   */
  recordFailure(
    proxy: string,
    target: string | undefined,
    err: unknown,
    config: { maxFatalErrors: number; fatalBanMs: number; banBaseMs: number; banMultiplier: number; banMaxMs: number },
    now = Date.now(),
  ) {
    const star = ensureStarEntry(this, proxy);
    const wasBanned = star.bannedUntil > now;
    const wasFrozen = star.frozenUntil > now;
    applyFailure(star, err, config, now);
    if (target && target !== '*') {
      const te = this.getTarget(proxy, target);
      if (te) {
        const _teWasBanned = te.bannedUntil > now;
        const _teWasFrozen = te.frozenUntil > now;
        applyFailure(te, err, config, now);
        this.dirtyTarget(proxy, target);
      } else {
        const ne = blankEntry();
        applyFailure(ne, err, config, now);
        this.setTarget(proxy, target, ne);
        this.dirtyTarget(proxy, target);
      }
    }
    this.dirty(proxy);
    // LOG: emit ban/freeze events only on state transitions
    const errorClass = classifyError(err);
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ proxy, target: target || '*', errorClass, error: errMsg }, 'failure recorded');
    if (!wasBanned && star.bannedUntil > now) {
      EventLog.safePush(this._eventLog, {
        type: 'ban',
        proxy,
        target: target || '*',
        status: 'info',
        error: errMsg,
        errorClass,
        detail: `errors=${star.errors}, fatalErrors=${star.fatalErrors}, bannedUntil=${new Date(star.bannedUntil).toISOString()}`,
      });
    }
    if (!wasFrozen && star.frozenUntil > now) {
      EventLog.safePush(this._eventLog, {
        type: 'freeze',
        proxy,
        target: target || '*',
        status: 'info',
        error: errMsg,
        errorClass: 'fatal',
        detail: `fatalErrors=${star.fatalErrors}`,
      });
    }
  }

  /**
   * Boot-time prune pass: demote any persisted frozen/banned-less-frozen rows
   * to a finite `pruneAfterMs` ban so the proxy can come back alive. Decay
   * fatalErrors to half so one more fatal re-freezes.
   */
  private _pruneFrozenOnBoot(pruneAfterMs: number, fatalBanMs: number) {
    const now = Date.now();
    const demotionPeriod = Math.min(pruneAfterMs, fatalBanMs * 3);
    const demotedTo = now + demotionPeriod;
    let count = 0;
    for (const [proxy, byTarget] of this._data) {
      for (const [target, e] of byTarget) {
        if (e.frozenUntil > 0) {
          e.frozenUntil = 0;
          e.bannedUntil = demotedTo;
          this._dirty.add(`${proxy}\x00${target}`);
          // Decay fatal errors so one more fatal re-freezes
          e.fatalErrors = Math.floor(e.fatalErrors / 2);
          e.errors = 0;
          count++;
          // LOG: emit unban event on boot thaw
          EventLog.safePush(this._eventLog, {
            type: 'unban',
            proxy,
            target: target || '*',
            status: 'info',
            detail: 'pruned on boot',
          });
        }
      }
    }
    if (count) logger.info({ count, demotionPeriod }, 'pruned frozen entries on boot');
  }

  scoreProxy(proxy: string, target?: string, now = Date.now()): number {
    const byTarget = this._data.get(proxy);
    if (!byTarget) return Infinity;
    if (target && byTarget.has(target)) {
      return this._score(byTarget.get(target)!, now);
    }
    const star = byTarget.get('*');
    return star ? this._score(star, now) : Infinity;
  }

  isAlive(proxy: string, target: string | undefined, maxErrors: number): boolean {
    const now = Date.now();
    const byTarget = this._data.get(proxy);
    if (!byTarget) return false;
    const star = byTarget.get('*');
    if (!star) return false;
    if (now < star.bannedUntil) return false;
    if (target) {
      const te = byTarget.get(target);
      if (te) {
        if (now < te.bannedUntil) return false;
      }
    }
    return true;
  }

  allEntries(): [string, HealthEntry][] {
    const result: [string, HealthEntry][] = [];
    for (const [proxy, byTarget] of this._data) {
      const star = byTarget.get('*');
      if (star) result.push([proxy, { ...star }]);
    }
    return result;
  }

  entries() {
    return this.allEntries();
  }
  [Symbol.iterator]() {
    return this.allEntries()[Symbol.iterator]();
  }

  load() {
    this._load();
  }
  stop() {
    clearInterval(this._timer);
    this._flush();
  }

  private _score(e: HealthEntry, now: number) {
    return HealthStore.computeScore(e, now);
  }

  static computeScore(e: HealthEntry, now = Date.now()): number {
    if (e.frozenUntil > 0 && now < e.frozenUntil) return Infinity;
    return e.latency + e.errors * 2000 + e.fatalErrors * 10000 - e.successes * 50;
  }

  private _load() {
    const rows = loadHealth(this.db);
    let count = 0;
    for (const r of rows) {
      let byTarget = this._data.get(r.proxy);
      if (!byTarget) {
        byTarget = new Map();
        this._data.set(r.proxy, byTarget);
      }
      if (!byTarget.has(r.target)) {
        byTarget.set(r.target, {
          errors: r.errors,
          successes: r.successes,
          latency: r.latency,
          bannedUntil: r.banned_until,
          lastOk: r.last_ok,
          fatalErrors: r.fatal_errors ?? 0,
          frozenUntil: r.frozen_until > 0 ? r.frozen_until : 0,
        });
        count++;
      }
    }
    if (count) logger.info({ count, totalProxies: this._data.size }, 'loaded health rows');
  }

  private _flush() {
    if (this._deleted.size) {
      const failed: string[] = [];
      for (const p of this._deleted) {
        try {
          removeProxyHealth(this.db, p);
        } catch {
          failed.push(p);
        }
      }
      this._deleted = new Set(failed);
    }
    if (!this._dirty.size) return;
    const entries = [...this._dirty];
    this._dirty.clear();
    const BATCH_SIZE = 200;
    const batches: string[][] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      batches.push(entries.slice(i, i + BATCH_SIZE));
    }
    for (const batch of batches) {
      const rows: HealthRowInput[] = [];
      for (const key of batch) {
        const sep = key.indexOf('\x00');
        const proxy = key.slice(0, sep);
        const target = key.slice(sep + 1);
        const byTarget = this._data.get(proxy);
        if (!byTarget) continue;
        const h = byTarget.get(target);
        if (!h) continue;
        rows.push({
          proxy,
          target,
          errors: h.errors,
          successes: h.successes,
          latency: h.latency,
          bannedUntil: h.bannedUntil,
          lastOk: h.lastOk,
          fatalErrors: h.fatalErrors,
          frozenUntil: h.frozenUntil,
        });
      }
      if (rows.length) {
        try {
          insertHealth(this.db, rows);
        } catch (e: unknown) {
          logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'flush error');
          for (const key of batch) this._dirty.add(key);
        }
      }
    }
  }
}
