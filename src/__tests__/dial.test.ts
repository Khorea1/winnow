import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHostPort, parseLine } from '../proxy/dial.js';
import { isBlockedTarget } from '../proxy/ssrf.js';

describe('parseHostPort', () => {
  it('parses host:port', () => {
    assert.deepEqual(parseHostPort('example.com:80'), { host: 'example.com', port: 80 });
  });

  it('defaults port to 443 when missing', () => {
    assert.deepEqual(parseHostPort('example.com'), { host: 'example.com', port: 443 });
  });

  it('parses IPv4 with port', () => {
    assert.deepEqual(parseHostPort('1.2.3.4:3128'), { host: '1.2.3.4', port: 3128 });
  });

  it('parses IPv4 without port', () => {
    assert.deepEqual(parseHostPort('10.0.0.1'), { host: '10.0.0.1', port: 443 });
  });

  it('parses bracketed IPv6 with port', () => {
    assert.deepEqual(parseHostPort('[::1]:8080'), { host: '::1', port: 8080 });
  });

  it('parses bracketed IPv6 without port', () => {
    assert.deepEqual(parseHostPort('[::1]'), { host: '::1', port: 443 });
  });

  it('parses bare IPv6 loopback', () => {
    assert.deepEqual(parseHostPort('::1'), { host: '::1', port: 443 });
  });

  it('parses bare IPv6 with port (::1:8080)', () => {
    assert.deepEqual(parseHostPort('::1:8080'), { host: '::1', port: 8080 });
  });

  it('parses IPv6-like with trailing segment (2001:db8::1)', () => {
    assert.deepEqual(parseHostPort('2001:db8::1'), { host: '2001:db8::1', port: 443 });
  });

  it('returns null for empty input', () => {
    assert.equal(parseHostPort(''), null);
  });

  it('returns null for whitespace-only input', () => {
    assert.equal(parseHostPort('  '), null);
  });

  it('uses custom default port', () => {
    assert.deepEqual(parseHostPort('example.com', 80), { host: 'example.com', port: 80 });
  });
});

describe('parseLine', () => {
  it('parses http:// URL', () => {
    const r = parseLine('http://user:pass@1.2.3.4:3128');
    assert.ok(r);
    assert.equal(r!.proto, 'http');
  });

  it('parses socks5:// URL', () => {
    const r = parseLine('socks5://1.2.3.4:1080');
    assert.ok(r);
    assert.equal(r!.proto, 'socks5');
  });

  it('adds http:// when scheme is missing', () => {
    const r = parseLine('1.2.3.4:3128');
    assert.ok(r);
    assert.equal(r!.proto, 'http');
  });

  it('returns null for blank lines', () => {
    assert.equal(parseLine(''), null);
  });

  it('returns null for whitespace', () => {
    assert.equal(parseLine('  '), null);
  });

  it('returns null for comments', () => {
    assert.equal(parseLine('# this is a comment'), null);
  });

  it('returns null for malformed URL', () => {
    assert.equal(parseLine('not a url at all !!!'), null);
  });

  it('trims whitespace', () => {
    const r = parseLine('  socks5://host:1080  ');
    assert.ok(r);
    assert.equal(r!.raw, 'socks5://host:1080');
  });
});

describe('isBlockedTarget', () => {
  it('blocks 127.0.0.1', () => {
    assert.equal(isBlockedTarget('127.0.0.1'), true);
  });

  it('blocks 127.255.255.255', () => {
    assert.equal(isBlockedTarget('127.255.255.255'), true);
  });

  it('blocks localhost', () => {
    assert.equal(isBlockedTarget('localhost'), true);
  });

  it('blocks 10.x.x.x (RFC 1918)', () => {
    assert.equal(isBlockedTarget('10.0.0.1'), true);
    assert.equal(isBlockedTarget('10.255.255.255'), true);
  });

  it('blocks 192.168.x.x (RFC 1918)', () => {
    assert.equal(isBlockedTarget('192.168.1.1'), true);
  });

  it('blocks 172.16-31.x.x (RFC 1918)', () => {
    assert.equal(isBlockedTarget('172.16.0.1'), true);
    assert.equal(isBlockedTarget('172.31.255.255'), true);
  });

  it('blocks 169.254.x.x (link-local)', () => {
    assert.equal(isBlockedTarget('169.254.1.1'), true);
  });

  it('blocks 100.64.x.x (RFC 6598 CGNAT)', () => {
    assert.equal(isBlockedTarget('100.64.0.1'), true);
    assert.equal(isBlockedTarget('100.127.255.255'), true);
  });

  it('blocks *.local hostnames', () => {
    assert.equal(isBlockedTarget('myhost.local'), true);
  });

  it('blocks *.internal hostnames', () => {
    assert.equal(isBlockedTarget('service.internal'), true);
  });

  it('blocks IPv6 loopback', () => {
    assert.equal(isBlockedTarget('::1'), true);
  });

  it('blocks IPv4-mapped loopback', () => {
    assert.equal(isBlockedTarget('::ffff:127.0.0.1'), true);
  });

  it('blocks IPv4-mapped RFC 1918', () => {
    assert.equal(isBlockedTarget('::ffff:10.0.0.1'), true);
    assert.equal(isBlockedTarget('::ffff:192.168.1.1'), true);
  });

  it('allows public IPv4', () => {
    assert.equal(isBlockedTarget('8.8.8.8'), false);
    assert.equal(isBlockedTarget('1.1.1.1'), false);
    assert.equal(isBlockedTarget('93.184.216.34'), false);
  });

  it('allows public IPv6', () => {
    assert.equal(isBlockedTarget('2001:4860:4860::8888'), false);
    assert.equal(isBlockedTarget('2606:4700:4700::1111'), false);
  });

  it('allows ULA (fc00::/7)', () => {
    // ULA is NOT blocked by design — internal networks legitimately use it
    assert.equal(isBlockedTarget('fd00::1'), false);
    assert.equal(isBlockedTarget('fc00::1'), false);
  });

  it('allows public hostnames', () => {
    assert.equal(isBlockedTarget('google.com'), false);
    assert.equal(isBlockedTarget('api.github.com'), false);
  });

  it('allows unknown TLDs', () => {
    assert.equal(isBlockedTarget('myinternal.xyz'), false);
  });

  it('blocks hex-encoded IPv4-mapped IPv6 (::ffff:7f00:1 = 127.0.0.1)', () => {
    assert.ok(isBlockedTarget('::ffff:7f00:1'));
  });

  it('blocks hex-encoded CGNAT (::ffff:6440:0101 = 100.64.1.1)', () => {
    assert.ok(isBlockedTarget('::ffff:6440:0101'));
  });

  it('allows public hex-encoded (::ffff:0808:0808 = 8.8.8.8)', () => {
    assert.equal(isBlockedTarget('::ffff:0808:0808'), false);
  });

  it('blocks metadata.google.internal', () => {
    assert.ok(isBlockedTarget('metadata.google.internal'));
  });

  it('blocks 169.254.169.254 (IMDS)', () => {
    assert.ok(isBlockedTarget('169.254.169.254'));
  });
});
