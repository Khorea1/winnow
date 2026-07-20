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
    assert.equal(opts.ttfbRatio, 100);
    assert.equal(opts.maxGap, 5000);
    assert.equal(opts.insecure, false);
    assert.equal(opts.strictTLS, false);
    assert.equal(opts.anonCheck, false);
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
});
