import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOptionsFromConfig } from '../validator/index.js';

// These cover the CLI/dashboard option-resolution helper directly, since it is
// what makes `npm run validator` (and the dashboard's POST /api/validate)
// respect config.json instead of silently using hardcoded values.
describe('buildOptionsFromConfig', () => {
  it('falls back to built-in defaults when config and overrides are both empty', () => {
    const opts = buildOptionsFromConfig({});
    assert.equal(opts.threads, 20);
    assert.equal(opts.mode, 'quick');
    assert.equal(opts.baseUrl, 'http://httpbin.org');
    assert.equal(opts.connectTimeout, 4);
    assert.equal(opts.maxLatency, 7000);
    assert.deepEqual(opts.timeouts, { tcpMs: 4000, httpMs: 12000, tlsMs: 4000, streamMs: 25000 });
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
    assert.equal(opts.connectTimeout, 9);
    assert.deepEqual(opts.timeouts, { tcpMs: 9000, httpMs: 6234, tlsMs: 9000, streamMs: 35000 });
    assert.equal(opts.ttfbRatio, 50);
    assert.equal(opts.maxGap, 999);
    assert.equal(opts.insecure, true);
    assert.equal(opts.strictTLS, true);
    assert.equal(opts.anonCheck, true);
    assert.equal(opts.throttle, 250);
    assert.equal(opts.tlsHost, 'example.org');
    assert.equal(opts.tlsPort, 8443);
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

  it('resolves stage timeouts after applying overrides and preserves millisecond units', () => {
    const opts = buildOptionsFromConfig({ validationConnectTimeout: 9, validationMaxLatency: 8000 }, { connectTimeout: 2, maxLatency: 1500 });
    assert.equal(opts.connectTimeout, 2);
    assert.equal(opts.maxLatency, 1500);
    assert.deepEqual(opts.timeouts, { tcpMs: 2000, httpMs: 6500, tlsMs: 2000, streamMs: 25000 });
  });

  it('rejects out-of-range and non-integer timeout values with built-in fallbacks', () => {
    const opts = buildOptionsFromConfig({ validationConnectTimeout: -3, validationMaxLatency: 90000 }, { connectTimeout: 1.5, maxLatency: Number.NaN });
    assert.equal(opts.connectTimeout, 4);
    assert.equal(opts.maxLatency, 7000);
    assert.deepEqual(opts.timeouts, { tcpMs: 4000, httpMs: 12000, tlsMs: 4000, streamMs: 25000 });
    assert.equal(buildOptionsFromConfig({}, { connectTimeout: 30, maxLatency: 30000 }).timeouts.httpMs, 35000);
    assert.equal(buildOptionsFromConfig({}, { connectTimeout: 1, maxLatency: 500 }).timeouts.tcpMs, 1000);
  });

  it('falls back to valid config values when a CLI timeout override is invalid', () => {
    const opts = buildOptionsFromConfig({ validationConnectTimeout: 8, validationMaxLatency: 3000 }, { connectTimeout: -1, maxLatency: Infinity });
    assert.deepEqual(opts.timeouts, { tcpMs: 8000, httpMs: 8000, tlsMs: 8000, streamMs: 25000 });
  });
});

import { validateFile } from '../validator/index.js';

// validateFile reads an actual file from disk, so unit-testing it is not practical
// without I/O mocking. Full coverage requires integration tests (e.g. pointing at a
// real proxy list, or mocking the filesystem). The core option-resolution logic is
// covered by the buildOptionsFromConfig tests above.
describe('validateFile', () => {
  it('is exported and callable', () => {
    assert.equal(typeof validateFile, 'function');
  });
});
