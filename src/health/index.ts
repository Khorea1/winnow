import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';

import { type HealthRowInput, insertHealth, loadHealth, removeProxyHealth } from '../db/index.js';
import { EventLog } from '../events.js';
import { createLogger } from '../logger.js';
import { applyFailure, applySuccess, classifyError, type HealthEntry } from './classify.js';

const logger = createLogger('health');

// ── Re-exports for backward compatibility ─────────────────────────────────
// classifyError, transientBanMs, applyFailure, applySuccess, HealthEntry
// moved to ./classify.ts.
export { applyFailure, applySuccess, classifyError, type HealthEntry, transientBanMs } from './classify.js';

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
  private _pendingUpdates: Set<string> = new Set();
  private _pendingEmitScheduled = false;

  constructor(db: Database.Database, config: { pruneAfterMs: number; fatalBanMs: number; maxFatalErrors?: number }, eventLog?: EventLog) {
    super();
    this.db = db;
    this._eventLog = eventLog;
    this._load();
    this._pruneFrozenOnBoot(config.pruneAfterMs, config.fatalBanMs, config.maxFatalErrors ?? 3);
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
    this._dirty.add(this._key(proxy, '*'));
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

  private _key(proxy: string, target: string): string {
    return `${proxy}\x00${target}`;
  }

  delete(proxy: string) {
    this._data.delete(proxy);
    this._deleted.add(proxy);
  }

  dirty(proxy: string) {
    this._dirty.add(this._key(proxy, '*'));
    this._pendingUpdates.add(this._key(proxy, '*'));
    this._scheduleFlushUpdates();
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
    this._dirty.add(this._key(proxy, target));
  }

  dirtyTarget(proxy: string, target: string) {
    this._dirty.add(this._key(proxy, target));
    this._pendingUpdates.add(this._key(proxy, target));
    this._scheduleFlushUpdates();
  }

  private _scheduleFlushUpdates() {
    if (this._pendingEmitScheduled) return;
    this._pendingEmitScheduled = true;
    queueMicrotask(() => this._flushUpdates());
  }

  private _flushUpdates() {
    this._pendingEmitScheduled = false;
    const now = Date.now();
    for (const key of this._pendingUpdates) {
      const sep = key.indexOf('\x00');
      const proxy = key.slice(0, sep);
      const target = key.slice(sep + 1);
      this.emit('health:update', { proxy, target, time: now });
    }
    this._pendingUpdates.clear();
  }
  /**
   * Record a success. Updates the per-target entry (if target given) AND the
   * `*` aggregate, mirroring the failure path's two-entry update. When target
   * is undefined, only the `*` aggregate is touched.
   */
  // DESIGN NOTE: successes on ANY target clear the aggregate ban — intentional.
  // A proxy that works for ANY target is better than one that works for none.

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
    const previousFrozenUntil = star.frozenUntil;
    applyFailure(star, err, config, now);
    if (target && target !== '*') {
      const te = this.getTarget(proxy, target);
      if (te) {
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
    } else if (wasFrozen && star.frozenUntil > previousFrozenUntil) {
      EventLog.safePush(this._eventLog, {
        type: 'freeze_extended',
        proxy,
        target: target || '*',
        status: 'info',
        error: errMsg,
        errorClass: 'fatal',
        detail: `fatalErrors=${star.fatalErrors}, frozenUntil=${new Date(star.frozenUntil).toISOString()}`,
      });
    }
  }

  /**
   * Boot-time prune pass: demote any persisted frozen/banned-less-frozen rows
   * to a finite `pruneAfterMs` ban so the proxy can come back alive. Reduce
   * fatalErrors by maxFatalErrors-1 so one more fatal reaches the threshold.
   */
  private _pruneFrozenOnBoot(pruneAfterMs: number, fatalBanMs: number, maxFatalErrors: number) {
    const now = Date.now();
    const demotionPeriod = Math.min(pruneAfterMs, fatalBanMs * 3);
    const demotedTo = now + demotionPeriod;
    let count = 0;
    for (const [proxy, byTarget] of this._data) {
      for (const [target, e] of byTarget) {
        if (e.frozenUntil > 0) {
          e.frozenUntil = 0;
          e.bannedUntil = demotedTo;
          this._dirty.add(this._key(proxy, target));
          // Decay fatal errors so one more fatal re-freezes
          e.fatalErrors = Math.max(0, e.fatalErrors - (maxFatalErrors - 1));
          e.errors = 0;
          count++;
          // LOG: emit unban event on boot thaw
          EventLog.safePush(this._eventLog, {
            type: 'demoted',
            proxy,
            target: target || '*',
            status: 'info',
            detail: 'frozen→banned on boot',
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
    if (star.errors > maxErrors) return false;
    if (now < star.frozenUntil) return false;
    if (target) {
      const te = byTarget.get(target);
      if (te) {
        if (now < te.bannedUntil) return false;
        if (te.errors > maxErrors) return false;
        if (now < te.frozenUntil) return false;
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
    this.removeAllListeners();
  }

  private _score(e: HealthEntry, now: number) {
    return HealthStore.computeScore(e, now);
  }

  static computeScore(e: HealthEntry, now = Date.now()): number {
    if ((e.frozenUntil > 0 && now < e.frozenUntil) || (e.bannedUntil > 0 && now < e.bannedUntil)) return Infinity;
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
