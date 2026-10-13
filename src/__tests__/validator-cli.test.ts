import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactProxy } from '../proxy/redact.js';
import { parseProxyForTcp, tcpCheck } from '../validator/checks/tcp.js';
import { buildOptionsFromConfig, validateFile } from '../validator/index.js';

// what makes the validator CLI and dashboard validation respect config.json.
describe('buildOptionsFromConfig', () => {
  it('falls back to built-in defaults when config and overrides are both empty', () => {
    const opts = buildOptionsFromConfig({});
    assert.equal(opts.threads, 20);
    assert.equal(opts.mode, 'quick');
    assert.equal(opts.baseUrl, 'http://httpbin.org');
    assert.deepEqual(opts.timeouts, { tcpMs: 4000, httpMs: 11000, tlsMs: 4000, streamMs: 25000 });
    assert.equal(opts.maxLatency, 7000);
    assert.equal(opts.ttfbRatio, 100);
    assert.equal(opts.maxGap, 5000);
    assert.equal(opts.insecure, false);
    assert.equal(opts.strictTLS, true);
    assert.equal(opts.anonCheck, true);
    assert.equal(opts.throttle, 100);
    assert.equal(opts.tlsHost, 'www.google.com');
    assert.equal(opts.tlsPort, 443);
  });

  it('picks up values from config.json when no CLI override is given', () => {
    const opts = buildOptionsFromConfig({
      validationThreads: 5,
      validationMode: 'strict',
      validationBaseUrl: 'http://example.com',
      validationMaxLatency: 1234,
      validationConnectTimeout: 9,
      validationTtfbRatio: 50,
      validationMaxGap: 999,
      validationInsecure: true,
      validationStrictTLS: true,
      validationAnonCheck: true,
      validationThrottle: 250,
      validationTlsHost: 'example.org',
      validationTlsPort: 8443,
    });
    assert.equal(opts.threads, 5);
    assert.equal(opts.mode, 'strict');
    assert.equal(opts.baseUrl, 'http://example.com');
    assert.equal(opts.maxLatency, 1234);
    assert.deepEqual(opts.timeouts, { tcpMs: 9000, httpMs: 10234, tlsMs: 9000, streamMs: 35000 });
    assert.equal(opts.ttfbRatio, 50);
    assert.equal(opts.maxGap, 999);
    assert.equal(opts.insecure, true);
    assert.equal(opts.strictTLS, true);
    assert.equal(opts.anonCheck, true);
    assert.equal(opts.throttle, 250);
    assert.equal(opts.tlsHost, 'example.org');
    assert.equal(opts.tlsPort, 8443);
  });

  it('resolves bounded budgets for the selected stage modes', () => {
    const standard = buildOptionsFromConfig({ validationMode: 'standard', validationConnectTimeout: 30, validationMaxLatency: 30000 });
    assert.deepEqual(standard.timeouts, { tcpMs: 30000, httpMs: 60000, tlsMs: 30000, streamMs: 25000 });
    const strictOverride = buildOptionsFromConfig({ validationMode: 'quick' }, { mode: 'strict', connectTimeout: 30 });
    assert.deepEqual(strictOverride.timeouts, { tcpMs: 30000, httpMs: 37000, tlsMs: 30000, streamMs: 35000 });
  });

  it('accepts tcp-only as a mode from config', () => {
    const opts = buildOptionsFromConfig({ validationMode: 'tcp-only' });
    assert.equal(opts.mode, 'tcp-only');
  });

  it('lets a CLI override win over config.json', () => {
    const opts = buildOptionsFromConfig({ validationThreads: 5, validationMode: 'strict' }, { threads: 40, mode: 'quick' });
    assert.equal(opts.threads, 40);
    assert.equal(opts.mode, 'quick');
  });

  it('lets a CLI override win over built-in defaults with an empty config', () => {
    const opts = buildOptionsFromConfig({}, { tlsHost: 'custom.example', tlsPort: 9443, maxGap: 0 });
    assert.equal(opts.tlsHost, 'custom.example');
    assert.equal(opts.tlsPort, 9443);
    assert.equal(opts.maxGap, 0);
  });
});

// validateFile reads an actual file from disk, so unit-testing it is not practical
// without I/O mocking. Full coverage requires integration tests (e.g. pointing at a
// real proxy list, or mocking the filesystem). The core option-resolution logic is
// covered by the buildOptionsFromConfig tests above.
describe('validateFile', () => {
  it('is exported and callable', () => {
    assert.equal(typeof validateFile, 'function');
  });
});
describe('redactProxy', () => {
  it('masks credentials while preserving the scheme and host', () => {
    assert.equal(redactProxy('http://user:secret@10.0.0.1:8080'), 'http://***:***@10.0.0.1:8080');
  });
  it('masks user-only and password-only proxy userinfo', () => {
    assert.equal(redactProxy('http://user@10.0.0.1:8080'), 'http://***:***@10.0.0.1:8080');
    assert.equal(redactProxy('http://:secret@10.0.0.1:8080'), 'http://***:***@10.0.0.1:8080');
  });
  it('leaves credential-less proxies untouched', () => {
    assert.equal(redactProxy('http://10.0.0.1:8080'), 'http://10.0.0.1:8080');
  });

  it('redacts credentials in error text and bare proxy authorities', () => {
    assert.equal(redactProxy('connection failed for user:secret@proxy.example:8080/path'), 'connection failed for ***:***@proxy.example:8080/path');
  });

  it('is idempotent and leaves unrelated malformed text unchanged', () => {
    const redacted = redactProxy('http://user:secret@proxy.example:8080/path');
    assert.equal(redactProxy(redacted), redacted);
    assert.equal(redactProxy('not a proxy: still plain text'), 'not a proxy: still plain text');
  });
});
describe('parseProxyForTcp', () => {
  it('defaults http proxies without port to 8080 (matches dial)', () => {
    assert.deepEqual(parseProxyForTcp('http://10.0.0.1'), { host: '10.0.0.1', port: 8080 });
  });

  it('defaults socks5 proxies without port to 1080 (matches dial)', () => {
    assert.deepEqual(parseProxyForTcp('socks5://10.0.0.1'), { host: '10.0.0.1', port: 1080 });
  });

  it('keeps explicit ports', () => {
    assert.deepEqual(parseProxyForTcp('http://10.0.0.1:3128'), { host: '10.0.0.1', port: 3128 });
  });

  it('unwraps IPv6 brackets so net.connect does not hang', () => {
    assert.deepEqual(parseProxyForTcp('http://[::1]:8080'), { host: '::1', port: 8080 });
  });
});

describe('buildOptionsFromConfig sanitize', () => {
  it('clamps out-of-range overrides to defaults', () => {
    const opts = buildOptionsFromConfig({}, { threads: 0, throttle: -5, tlsPort: 99999, connectTimeout: 0, maxLatency: 1 });
    assert.equal(opts.threads, 20);
    assert.equal(opts.throttle, 100);
    assert.equal(opts.tlsPort, 443);
    assert.deepEqual(opts.timeouts, { tcpMs: 4000, httpMs: 11000, tlsMs: 4000, streamMs: 25000 });
    assert.equal(opts.maxLatency, 7000);
  });

  it('falls back for empty strings', () => {
    const opts = buildOptionsFromConfig({}, { baseUrl: '   ', tlsHost: '' });
    assert.equal(opts.baseUrl, 'http://httpbin.org');
    assert.equal(opts.tlsHost, 'www.google.com');
  });

  it('respects explicit false flags (--no-strict-tls/--no-anon-check/--no-insecure)', () => {
    const opts = buildOptionsFromConfig({ validationStrictTLS: true, validationAnonCheck: true }, { strictTLS: false, anonCheck: false, insecure: false });
    assert.equal(opts.strictTLS, false);
    assert.equal(opts.anonCheck, false);
    assert.equal(opts.insecure, false);
  });
});

describe('tcpCheck abort', () => {
  it('rejects with aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tcpCheck('127.0.0.1', 9, 5000, controller.signal), /aborted/);
  });
});
