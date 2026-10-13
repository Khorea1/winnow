import assert from 'node:assert/strict';
import dns from 'node:dns';
import { describe, it } from 'node:test';
import { isBlockedTarget, resolveTargetAddress } from '../proxy/ssrf.js';

describe('isBlockedTarget — IPv4', () => {
  it('blocks 127.0.0.1 (loopback)', () => {
    assert.equal(isBlockedTarget('127.0.0.1'), true);
  });

  it('blocks 10.0.0.1 (RFC 1918 10/8)', () => {
    assert.equal(isBlockedTarget('10.0.0.1'), true);
  });

  it('blocks 172.16.0.1 (RFC 1918 172.16/12)', () => {
    assert.equal(isBlockedTarget('172.16.0.1'), true);
  });

  it('blocks 192.168.1.1 (RFC 1918 192.168/16)', () => {
    assert.equal(isBlockedTarget('192.168.1.1'), true);
  });

  it('blocks 100.64.0.1 (RFC 6598 CGNAT)', () => {
    assert.equal(isBlockedTarget('100.64.0.1'), true);
  });

  it('blocks 169.254.169.254 (link-local / cloud metadata)', () => {
    assert.equal(isBlockedTarget('169.254.169.254'), true);
  });

  it('blocks 0.0.0.0', () => {
    assert.equal(isBlockedTarget('0.0.0.0'), true);
  });

  it('does not block 8.8.8.8 (public IP)', () => {
    assert.equal(isBlockedTarget('8.8.8.8'), false);
  });
});

describe('isBlockedTarget — IPv6 native', () => {
  it('blocks ::1 (loopback)', () => {
    assert.equal(isBlockedTarget('::1'), true);
  });

  it('blocks :: (unspecified)', () => {
    assert.equal(isBlockedTarget('::'), true);
  });

  it('does not block fc00::1 (ULA — not blocked per design)', () => {
    assert.equal(isBlockedTarget('fc00::1'), false);
  });

  it('blocks fe80::/10 link-local addresses', () => {
    assert.equal(isBlockedTarget('fe80::1'), true);
    assert.equal(isBlockedTarget('febf::1'), true);
    assert.equal(isBlockedTarget('fec0::1'), false);
  });

  it('blocks bracketed IPv6 URL hostnames and bracketed zone IDs', () => {
    assert.equal(isBlockedTarget('[::1]'), true);
    assert.equal(isBlockedTarget('[fe80::1]'), true);
    assert.equal(isBlockedTarget('[fe80::1%eth0]'), true);
  });
});

describe('isBlockedTarget — IPv4-mapped IPv6 (SSRF bypass vectors)', () => {
  it('blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
    assert.equal(isBlockedTarget('::ffff:127.0.0.1'), true);
  });

  it('blocks ::ffff:10.0.0.1 (IPv4-mapped private 10/8)', () => {
    assert.equal(isBlockedTarget('::ffff:10.0.0.1'), true);
  });

  it('blocks ::ffff:169.254.169.254 (IPv4-mapped link-local / metadata)', () => {
    assert.equal(isBlockedTarget('::ffff:169.254.169.254'), true);
  });

  it('blocks ::ffff:7f00:1 (hex-encoded IPv4-mapped loopback → 127.0.0.1)', () => {
    assert.equal(isBlockedTarget('::ffff:7f00:1'), true);
  });

  it('blocks 0:0:0:0:0:ffff:7f00:1 (expanded hex-encoded IPv4-mapped loopback)', () => {
    assert.equal(isBlockedTarget('0:0:0:0:0:ffff:7f00:1'), true);
  });

  it('does not block ::ffff:8.8.8.8 (IPv4-mapped public IP)', () => {
    assert.equal(isBlockedTarget('::ffff:8.8.8.8'), false);
  });
});

describe('isBlockedTarget — hostnames', () => {
  it('does not block example.com (normal hostname)', () => {
    assert.equal(isBlockedTarget('example.com'), false);
  });

  it('blocks *.local suffix', () => {
    assert.equal(isBlockedTarget('myhost.local'), true);
  });

  it('blocks *.internal suffix', () => {
    assert.equal(isBlockedTarget('myhost.internal'), true);
  });

  it('blocks localhost', () => {
    assert.equal(isBlockedTarget('localhost'), true);
  });

  it('blocks metadata.google.internal (GCP metadata endpoint)', () => {
    assert.equal(isBlockedTarget('metadata.google.internal'), true);
  });
});

describe('resolveTargetAddress — DNS rebinding boundary', () => {
  it('pins a public address after checking every DNS answer', async (t) => {
    let queries = 0;
    t.mock.method(dns.promises, 'lookup', async () => {
      queries++;
      return [
        { address: '198.51.100.42', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 },
      ];
    });
    assert.equal(await resolveTargetAddress('public.example'), '198.51.100.42');
    assert.equal(queries, 1);
  });

  it('rejects an entire DNS answer set containing even one private address', async (t) => {
    t.mock.method(dns.promises, 'lookup', async () => [
      { address: '198.51.100.42', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await assert.rejects(resolveTargetAddress('rebind.example'), /blocked by SSRF/);
  });

  it('rejects a private IPv4-mapped IPv6 DNS answer', async (t) => {
    t.mock.method(dns.promises, 'lookup', async () => [{ address: '::ffff:7f00:1', family: 6 }]);
    await assert.rejects(resolveTargetAddress('mapped.example'), /blocked by SSRF/);
  });

  it('fails closed on DNS errors and empty answers', async (t) => {
    const lookup = t.mock.method(dns.promises, 'lookup', async () => {
      throw new Error('ENOTFOUND');
    });
    await assert.rejects(resolveTargetAddress('unknown.example'), /target DNS resolution failed/);
    lookup.mock.mockImplementation((async () => []) as unknown as typeof dns.promises.lookup);
    await assert.rejects(resolveTargetAddress('unknown.example'), /target DNS resolution failed/);
  });

  it('does not query DNS for literal IPs or denied hostnames', async (t) => {
    const lookup = t.mock.method(dns.promises, 'lookup', async () => [{ address: '198.51.100.42', family: 4 }]);
    assert.equal(await resolveTargetAddress('8.8.8.8'), '8.8.8.8');
    assert.equal(await resolveTargetAddress('[2001:4860:4860::8888]'), '2001:4860:4860::8888');
    await assert.rejects(resolveTargetAddress('metadata.google.internal'), /blocked by SSRF/);
    await assert.rejects(resolveTargetAddress('fe80::1%eth0'), /blocked by SSRF/);
    assert.equal(lookup.mock.callCount(), 0);
  });
});
