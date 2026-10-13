import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyProxy, sortAndFilterProxies } from '../../../public/dashboard-utils.js';

const NOW = 10_000;

function proxy(name, values = {}) {
  return {
    proxy: name,
    frozen: false,
    banned: false,
    bannedUntil: 0,
    errors: 0,
    latency: 100,
    score: 100,
    successes: 0,
    ...values,
  };
}

describe('classifyProxy', () => {
  it('preserves frozen/banned, error, latency, and healthy status priority', () => {
    assert.equal(classifyProxy(proxy('frozen', { frozen: true, errors: 8 }), NOW), 'ban');
    assert.equal(classifyProxy(proxy('active ban', { bannedUntil: NOW + 1, errors: 8 }), NOW), 'ban');
    assert.equal(classifyProxy(proxy('explicit ban', { banned: true, errors: 8 }), NOW), 'ban');
    assert.equal(classifyProxy(proxy('errors', { errors: 3, latency: 9000 }), NOW), 'err');
    assert.equal(classifyProxy(proxy('slow', { latency: 1926 }), NOW), 'warn');
    assert.equal(classifyProxy(proxy('healthy'), NOW), 'ok');
  });

  it('uses the configured error limit and timeout, including existing falsy timeout fallback', () => {
    assert.equal(classifyProxy(proxy('threshold', { errors: 2 }), NOW, { maxErrors: 2 }), 'err');
    assert.equal(classifyProxy(proxy('custom slow', { latency: 551 }), NOW, { timeout: 1000 }), 'warn');
    assert.equal(classifyProxy(proxy('falsy timeout', { latency: 1900 }), NOW, { timeout: 0 }), 'ok');
  });

  it('uses the exact banned-until boundary and excludes the latency sentinel from warnings', () => {
    assert.equal(classifyProxy(proxy('boundary', { bannedUntil: NOW }), NOW), 'ok');
    assert.equal(classifyProxy(proxy('sentinel', { latency: 9999 }), NOW), 'ok');
  });
});

describe('sortAndFilterProxies', () => {
  const rows = [
    proxy('Beta', { score: 20, latency: 300, errors: 2, successes: 1 }),
    proxy('alpha', { score: 10, latency: 100, errors: 0, successes: 5 }),
    proxy('ALPHA', { score: 10, latency: 200, errors: 0, successes: 5 }),
    proxy('gamma', { score: 30, latency: 9999, errors: 3, successes: 2 }),
  ];

  it('sorts by every supported key and defaults unknown keys to score', () => {
    const cases = [
      ['proxy', ['alpha', 'ALPHA', 'Beta', 'gamma']],
      ['status', ['gamma', 'Beta', 'alpha', 'ALPHA']],
      ['score', ['alpha', 'ALPHA', 'Beta', 'gamma']],
      ['latency', ['alpha', 'ALPHA', 'Beta', 'gamma']],
      ['errors', ['alpha', 'ALPHA', 'Beta', 'gamma']],
      ['ok', ['Beta', 'gamma', 'alpha', 'ALPHA']],
      ['unknown', ['alpha', 'ALPHA', 'Beta', 'gamma']],
    ];
    for (const [sortKey, expected] of cases) {
      assert.deepEqual(
        sortAndFilterProxies(rows, { sortKey, now: NOW }).map((row) => row.proxy),
        expected,
        sortKey,
      );
    }
  });

  it('sorts descending and applies case-insensitive proxy value sorting', () => {
    assert.deepEqual(
      sortAndFilterProxies(rows, { sortKey: 'proxy', sortDir: 'desc', now: NOW }).map((row) => row.proxy),
      ['gamma', 'Beta', 'alpha', 'ALPHA'],
    );
  });

  it('applies the literal lower-case text filter and status filter together', () => {
    assert.deepEqual(
      sortAndFilterProxies(rows, { filterTerm: 'a', statusFilter: new Set(['err']), sortKey: 'proxy', now: NOW }).map((row) => row.proxy),
      ['gamma'],
    );
    assert.deepEqual(sortAndFilterProxies(rows, { filterTerm: 'A', now: NOW }), []);
  });

  it('does not mutate the input and preserves original order for equal sort values', () => {
    const input = [proxy('first', { score: 7 }), proxy('second', { score: 7 }), proxy('third', { score: 7 })];
    const snapshot = input.slice();
    const sorted = sortAndFilterProxies(input, { sortKey: 'score', now: NOW });
    assert.deepEqual(
      sorted.map((row) => row.proxy),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(input, snapshot);
    assert.notEqual(sorted, input);
  });

  it('uses the supplied now value for status filters and status sorting', () => {
    const row = proxy('temporary ban', { bannedUntil: NOW + 1 });
    assert.deepEqual(sortAndFilterProxies([row], { statusFilter: new Set(['ban']), now: NOW }), [row]);
    assert.deepEqual(sortAndFilterProxies([row], { statusFilter: new Set(['ok']), now: NOW + 1 }), [row]);
  });
});
