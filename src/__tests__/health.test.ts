import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HealthEntry } from '../health/index.js';
import { applyFailure, applySuccess, blankEntry, classifyError, transientBanMs } from '../health/index.js';

function entry(e: Partial<HealthEntry> = {}): HealthEntry {
  return { errors: 0, successes: 0, latency: 200, bannedUntil: 0, lastOk: 0, fatalErrors: 0, frozenUntil: 0, ...e };
}

const CONFIG = { maxFatalErrors: 3, fatalBanMs: 300000, banBaseMs: 30000, banMultiplier: 2, banMaxMs: 180000 };

describe('blankEntry', () => {
  it('returns entry with default values', () => {
    const b = blankEntry();
    assert.equal(b.errors, 0);
    assert.equal(b.successes, 0);
    assert.equal(b.latency, 9999);
    assert.equal(b.bannedUntil, 0);
    assert.equal(b.lastOk, 0);
    assert.equal(b.fatalErrors, 0);
    assert.equal(b.frozenUntil, 0);
  });
});

describe('applySuccess', () => {
  it('updates latency EMA on first success', () => {
    const h = blankEntry();
    applySuccess(h, 500, 1000);
    assert.equal(h.latency, 500);
    assert.equal(h.lastOk, 1000);
  });

  it('smooths latency with EMA 0.7/0.3', () => {
    const h = entry({ latency: 200 });
    applySuccess(h, 400, 2000);
    assert.equal(h.latency, 260); // 200 * 0.7 + 400 * 0.3 = 260
  });

  it('decrements errors on success (min 0)', () => {
    const h = entry({ errors: 3 });
    applySuccess(h, 100, 3000);
    assert.equal(h.errors, 2);
  });

  it('does not decrement errors below 0', () => {
    const h = entry({ errors: 0 });
    applySuccess(h, 100, 3000);
    assert.equal(h.errors, 0);
  });

  it('increments successes', () => {
    const h = entry({ successes: 5 });
    applySuccess(h, 100, 3000);
    assert.equal(h.successes, 6);
  });

  it('clears bannedUntil', () => {
    const h = entry({ bannedUntil: 999999 });
    applySuccess(h, 100, 4000);
    assert.equal(h.bannedUntil, 0);
  });

  it('does not clear frozenUntil', () => {
    const h = entry({ frozenUntil: 999999 });
    applySuccess(h, 100, 4000);
    assert.equal(h.frozenUntil, 999999);
  });

  it('does not reset fatalErrors', () => {
    const h = entry({ fatalErrors: 2 });
    applySuccess(h, 100, 4000);
    assert.equal(h.fatalErrors, 2);
  });
});

describe('applyFailure', () => {
  it('classifies ECONNREFUSED as fatal', () => {
    const h = entry();
    applyFailure(h, { code: 'ECONNREFUSED' }, CONFIG, 1000);
    assert.equal(h.fatalErrors, 1);
    assert.equal(h.bannedUntil, 1000 + CONFIG.fatalBanMs);
  });

  it('freezes after maxFatalErrors', () => {
    const h = entry({ fatalErrors: 2 });
    applyFailure(h, { code: 'ECONNREFUSED' }, CONFIG, 1000);
    assert.equal(h.fatalErrors, 3);
    assert.equal(h.frozenUntil, 1000 + CONFIG.fatalBanMs * 3);
  });

  it('classifies ETIMEDOUT as transient', () => {
    const h = entry();
    applyFailure(h, { code: 'ETIMEDOUT' }, CONFIG, 1000);
    assert.equal(h.errors, 1);
    assert.equal(h.fatalErrors, 0);
  });

  it('applies exponential transient ban', () => {
    const h = entry({ errors: 2 });
    applyFailure(h, { code: 'ETIMEDOUT' }, CONFIG, 1000);
    // errors=3, ban = min(30000 * 2^2, 180000) = min(120000, 180000) = 120000
    assert.equal(h.errors, 3);
    assert.equal(h.bannedUntil, 1000 + 120000);
  });

  it('caps transient ban at banMaxMs', () => {
    const h = entry({ errors: 10 });
    applyFailure(h, { code: 'ETIMEDOUT' }, CONFIG, 1000);
    assert.equal(h.bannedUntil, 1000 + CONFIG.banMaxMs);
  });

  it('increments errors for transient', () => {
    const h = entry({ errors: 0 });
    applyFailure(h, { code: 'ETIMEDOUT' }, CONFIG, 1000);
    assert.equal(h.errors, 1);
  });

  it('does not increment successes on failure', () => {
    const h = entry({ successes: 5 });
    applyFailure(h, { code: 'ETIMEDOUT' }, CONFIG, 1000);
    assert.equal(h.successes, 5);
  });
});

describe('classifyError', () => {
  it('null -> transient', () => {
    assert.equal(classifyError(null), 'transient');
  });

  it('ECONNREFUSED -> fatal', () => {
    assert.equal(classifyError({ code: 'ECONNREFUSED' }), 'fatal');
  });

  it('ENOTFOUND -> fatal', () => {
    assert.equal(classifyError({ code: 'ENOTFOUND' }), 'fatal');
  });

  it('ERR_TLS_CERT_ALTNAME_INVALID -> fatal', () => {
    assert.equal(classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'fatal');
  });

  it('ECONNRESET -> transient (not in FATAL_ERR_CODES)', () => {
    assert.equal(classifyError({ code: 'ECONNRESET' }), 'transient');
  });

  it('SOCKS general failure (reply 0x01) -> fatal', () => {
    assert.equal(classifyError({ socksReply: 0x01 }), 'fatal');
  });

  it('SOCKS connection not allowed (reply 0x02) -> fatal', () => {
    assert.equal(classifyError({ socksReply: 0x02 }), 'fatal');
  });

  it('SOCKS unreachable (reply 0x04) -> fatal', () => {
    assert.equal(classifyError({ socksReply: 0x04 }), 'fatal');
  });

  it('SOCKS reply 0x06 (TTL expired) -> transient', () => {
    assert.equal(classifyError({ socksReply: 0x06 }), 'transient');
  });

  it('timeout message -> transient', () => {
    assert.equal(classifyError({ message: 'timeout' }), 'transient');
  });

  it('upstream 502 -> transient', () => {
    assert.equal(classifyError({ message: 'upstream 502' }), 'transient');
  });

  it('socket hang up -> transient', () => {
    assert.equal(classifyError({ message: 'socket hang up' }), 'transient');
  });

  it('ETIMEDOUT -> transient', () => {
    assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'transient');
  });

  it('TLS-related message -> fatal', () => {
    assert.equal(classifyError({ message: 'TLS handshake failed' }), 'fatal');
  });

  it('certificate error message -> fatal', () => {
    assert.equal(classifyError({ message: 'self-signed certificate' }), 'fatal');
  });

  it('SOCKS protocol error -> fatal', () => {
    assert.equal(classifyError({ message: 'SOCKS protocol error' }), 'fatal');
  });
});

describe('transientBanMs', () => {
  it('first error returns banBaseMs', () => {
    assert.equal(transientBanMs(1, 30000, 2, 180000), 30000);
  });

  it('second error doubles', () => {
    assert.equal(transientBanMs(2, 30000, 2, 180000), 60000);
  });

  it('third error quadruples', () => {
    assert.equal(transientBanMs(3, 30000, 2, 180000), 120000);
  });

  it('caps at banMaxMs', () => {
    assert.equal(transientBanMs(10, 30000, 2, 180000), 180000);
  });

  it('uses custom base and multiplier', () => {
    assert.equal(transientBanMs(2, 10000, 3, 999999), 30000);
  });

  it('clamps exponent at 6 and respects banMaxMs', () => {
    // errors=7, exponent = min(6,6) = 6 -> raw = 30000 * 2^6 = 1920000, capped 999999
    assert.equal(transientBanMs(7, 30000, 2, 999999), 999999);
  });
});
