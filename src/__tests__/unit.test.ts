import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Helper to create a HealthEntry snapshot for computeScore tests
import { type HealthEntry, HealthStore } from '../health/index.js';
import { parseHostPort, parseLine } from '../proxy/dial.js';

function health(e: Partial<HealthEntry>): HealthEntry {
  return { errors: 0, successes: 0, latency: 200, bannedUntil: 0, lastOk: 0, fatalErrors: 0, frozenUntil: 0, ...e };
}

// ── parseHostPort ─────────────────────────────────────────

describe('parseHostPort', () => {
  it('null → null', () => {
    assert.equal(parseHostPort(null as unknown as string), null);
  });

  it('example.com → host=example.com port=443', () => {
    assert.deepEqual(parseHostPort('example.com'), { host: 'example.com', port: 443 });
  });

  it('example.com:8080 → host=example.com port=8080', () => {
    assert.deepEqual(parseHostPort('example.com:8080'), { host: 'example.com', port: 8080 });
  });

  it('[::1]:8080 → host=::1 port=8080', () => {
    assert.deepEqual(parseHostPort('[::1]:8080'), { host: '::1', port: 8080 });
  });

  it('192.168.1.1:3128 → host=192.168.1.1 port=3128', () => {
    assert.deepEqual(parseHostPort('192.168.1.1:3128'), { host: '192.168.1.1', port: 3128 });
  });
});

// ── parseLine ─────────────────────────────────────────────

describe('parseLine', () => {
  it('comment line → null', () => {
    assert.equal(parseLine('#'), null);
  });

  it('empty string → null', () => {
    assert.equal(parseLine(''), null);
  });

  it('192.168.1.1:8080 → raw=http://192.168.1.1:8080 proto=http', () => {
    const r = parseLine('192.168.1.1:8080');
    assert.ok(r);
    assert.equal(r?.raw, '192.168.1.1:8080');
    assert.equal(r?.proto, 'http');
  });

  it('socks5://192.168.1.1:1080 → proto=socks5', () => {
    const r = parseLine('socks5://192.168.1.1:1080');
    assert.ok(r);
    assert.equal(r?.proto, 'socks5');
  });
});

// ── computeScore ──────────────────────────────────────────

describe('computeScore', () => {
  it('latency=0 → 0', () => {
    assert.equal(HealthStore.computeScore(health({ latency: 0 })), 0);
  });
  it('errors=0 successes=0 latency=200 → 200', () => {
    assert.equal(HealthStore.computeScore(health({})), 200);
  });

  it('banned (bannedUntil > now) → Infinity', () => {
    assert.equal(HealthStore.computeScore(health({ bannedUntil: 200 }), 100), Infinity);
  });

  it('frozen (frozenUntil > now) → Infinity', () => {
    assert.equal(HealthStore.computeScore(health({ frozenUntil: 200 }), 100), Infinity);
  });

  it('errors=1 → 2200 (200 + 1*2000)', () => {
    assert.equal(HealthStore.computeScore(health({ errors: 1 })), 2200);
  });

  it('successes=1 → 150 (200 - 1*50)', () => {
    assert.equal(HealthStore.computeScore(health({ successes: 1 })), 150);
  });

  it('fatalErrors=1 → 10200 (200 + 1*10000)', () => {
    assert.equal(HealthStore.computeScore(health({ fatalErrors: 1 })), 10200);
  });
});
