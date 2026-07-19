import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { classifyError, transientBanMs, HealthEntry, blankEntry } from '../health'
import { parseHostPort, parseLine } from '../proxy/dial'

// Helper to create a HealthEntry snapshot for computeScore tests
import { HealthStore } from '../health'

function health(e: Partial<HealthEntry>): HealthEntry {
  return { errors: 0, successes: 0, latency: 200, bannedUntil: 0, lastOk: 0, fatalErrors: 0, frozenUntil: 0, ...e }
}

// ── classifyError ─────────────────────────────────────────

describe('classifyError', () => {
  it('null → transient', () => {
    assert.equal(classifyError(null), 'transient')
  })

  it('ECONNREFUSED → fatal', () => {
    assert.equal(classifyError({ code: 'ECONNREFUSED' }), 'fatal')
  })

  it('ENOTFOUND → fatal', () => {
    assert.equal(classifyError({ code: 'ENOTFOUND' }), 'fatal')
  })

  it('ERR_TLS_CERT_ALTNAME_INVALID → fatal', () => {
    assert.equal(classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'fatal')
  })

  it('SOCKS general failure (reply 0x01) → fatal', () => {
    assert.equal(classifyError({ socksReply: 0x01 }), 'fatal')
  })

  it('timeout http → transient', () => {
    assert.equal(classifyError({ message: 'timeout http' }), 'transient')
  })

  it('upstream 502 → transient', () => {
    assert.equal(classifyError({ message: 'upstream 502' }), 'transient')
  })

  it('socket hang up → transient', () => {
    assert.equal(classifyError({ message: 'socket hang up' }), 'transient')
  })

  it('ETIMEDOUT → transient (not in FATAL_ERR_CODES)', () => {
    assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'transient')
  })
})

// ── transientBanMs ────────────────────────────────────────

describe('transientBanMs', () => {
  it('errors=1 base=30k mult=2 max=180k → 30_000', () => {
    assert.equal(transientBanMs(1, 30_000, 2, 180_000), 30_000)
  })

  it('errors=2 base=30k mult=2 max=180k → 60_000', () => {
    assert.equal(transientBanMs(2, 30_000, 2, 180_000), 60_000)
  })

  it('errors=7 base=30k mult=2 max=180k → 180_000 (capped)', () => {
    assert.equal(transientBanMs(7, 30_000, 2, 180_000), 180_000)
  })

  it('errors=3 base=10k mult=3 max=300k → 90_000', () => {
    assert.equal(transientBanMs(3, 10_000, 3, 300_000), 90_000)
  })
})

// ── parseHostPort ─────────────────────────────────────────

describe('parseHostPort', () => {
  it('null → null', () => {
    assert.equal(parseHostPort(null as unknown as string), null)
  })

  it('example.com → host=example.com port=443', () => {
    assert.deepEqual(parseHostPort('example.com'), { host: 'example.com', port: 443 })
  })

  it('example.com:8080 → host=example.com port=8080', () => {
    assert.deepEqual(parseHostPort('example.com:8080'), { host: 'example.com', port: 8080 })
  })

  it('[::1]:8080 → host=::1 port=8080', () => {
    assert.deepEqual(parseHostPort('[::1]:8080'), { host: '::1', port: 8080 })
  })

  it('192.168.1.1:3128 → host=192.168.1.1 port=3128', () => {
    assert.deepEqual(parseHostPort('192.168.1.1:3128'), { host: '192.168.1.1', port: 3128 })
  })
})

// ── parseLine ─────────────────────────────────────────────

describe('parseLine', () => {
  it('comment line → null', () => {
    assert.equal(parseLine('#'), null)
  })

  it('empty string → null', () => {
    assert.equal(parseLine(''), null)
  })

  it('192.168.1.1:8080 → raw=http://192.168.1.1:8080 proto=http', () => {
    const r = parseLine('192.168.1.1:8080')
    assert.ok(r)
    assert.equal(r!.raw, 'http://192.168.1.1:8080')
    assert.equal(r!.proto, 'http')
  })

  it('socks5://192.168.1.1:1080 → proto=socks5', () => {
    const r = parseLine('socks5://192.168.1.1:1080')
    assert.ok(r)
    assert.equal(r!.proto, 'socks5')
  })
})

// ── computeScore ──────────────────────────────────────────

describe('computeScore', () => {
  it('errors=0 successes=0 latency=200 → 200', () => {
    assert.equal(HealthStore.computeScore(health({})), 200)
  })

  it('banned (bannedUntil > now) → Infinity', () => {
    assert.equal(HealthStore.computeScore(health({ bannedUntil: Date.now() + 10000 })), Infinity)
  })

  it('frozen (frozenUntil > now) → Infinity', () => {
    assert.equal(HealthStore.computeScore(health({ frozenUntil: Date.now() + 10000 })), Infinity)
  })

  it('errors=1 → 2200 (200 + 1*2000)', () => {
    assert.equal(HealthStore.computeScore(health({ errors: 1 })), 2200)
  })

  it('successes=1 → 150 (200 - 1*50)', () => {
    assert.equal(HealthStore.computeScore(health({ successes: 1 })), 150)
  })

  it('fatalErrors=1 → 10200 (200 + 1*10000)', () => {
    assert.equal(HealthStore.computeScore(health({ fatalErrors: 1 })), 10200)
  })
})
