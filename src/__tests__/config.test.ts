import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULTS, loadConfig, type RotatorConfig, updateConfig } from '../config/index.js';

describe('DEFAULTS', () => {
  it('has expected default port', () => {
    assert.equal(DEFAULTS.port, 8080);
  });

  it('has expected retries', () => {
    assert.equal(DEFAULTS.retries, 5);
  });

  it('has expected timeout', () => {
    assert.equal(DEFAULTS.timeout, 3500);
  });

  it('healthCheckInterval defaults to 15000', () => {
    assert.equal(DEFAULTS.healthCheckInterval, 15000);
  });

  it('healthCheckCount defaults to 10', () => {
    assert.equal(DEFAULTS.healthCheckCount, 10);
  });

  it('healthCheckParallel defaults to true', () => {
    assert.equal(DEFAULTS.healthCheckParallel, true);
  });

  it('has expected ban defaults', () => {
    assert.equal(DEFAULTS.banBaseMs, 30000);
    assert.equal(DEFAULTS.banMaxMs, 180000);
    assert.equal(DEFAULTS.banMultiplier, 2);
    assert.equal(DEFAULTS.fatalBanMs, 300000);
    assert.equal(DEFAULTS.maxFatalErrors, 3);
  });

  it('has expected validation defaults', () => {
    assert.equal(DEFAULTS.validationMode, 'quick');
    assert.equal(DEFAULTS.validationThreads, 20);
    assert.equal(DEFAULTS.validationMaxLatency, 7000);
    assert.equal(DEFAULTS.validationConnectTimeout, 4);
    assert.equal(DEFAULTS.validationPrune, true);
  });

  it('DEFAULTS has all required fields', () => {
    const requiredFields = [
      'port',
      'proxyFile',
      'targets',
      'retries',
      'maxErrors',
      'timeout',
      'maxFatalErrors',
      'fatalBanMs',
      'banBaseMs',
      'banMultiplier',
      'banMaxMs',
      'pruneAfterMs',
      'upstreamIdleTimeout',
      'healthCheckInterval',
      'healthCheckCount',
      'healthCheckParallel',
    ];
    for (const f of requiredFields) {
      assert.ok(f in DEFAULTS, `DEFAULTS missing ${f}`);
    }
  });
});

describe('loadConfig', () => {
  it('loads from a valid config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;

    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          port: 9090,
          proxyFile: 'test.txt',
          targets: ['example.com:80'],
          retries: 3,
        }),
      );

      const cfg = loadConfig();
      assert.equal(cfg.port, 9090);
      // proxyFile is resolved to absolute path
      assert.ok(cfg.proxyFile.endsWith('/test.txt'), `expected /test.txt suffix, got ${cfg.proxyFile}`);
      assert.deepEqual(cfg.targets, ['example.com:80']);
      assert.equal(cfg.retries, 3);
      // Other values fall back to defaults
      assert.equal(cfg.timeout, DEFAULTS.timeout);
      assert.equal(cfg.banBaseMs, DEFAULTS.banBaseMs);
    } finally {
      if (orig) process.env.WINNOW_CONFIG = orig;
      else delete process.env.WINNOW_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clamps out-of-range values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;

    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          port: 99999,
          retries: -1,
          banBaseMs: -5000,
          banMaxMs: 999999999,
          validationMode: 'invalid-mode',
        }),
      );

      const cfg = loadConfig();
      assert.equal(cfg.port, DEFAULTS.port); // clamped (99999 > 65535)
      assert.equal(cfg.retries, DEFAULTS.retries);
      assert.equal(cfg.banBaseMs, DEFAULTS.banBaseMs);
      assert.equal(cfg.banMaxMs, DEFAULTS.banMaxMs); // clamped by banBaseMs lower bound + default
      assert.equal(cfg.validationMode, DEFAULTS.validationMode); // invalid -> default
    } finally {
      if (orig) process.env.WINNOW_CONFIG = orig;
      else delete process.env.WINNOW_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects validationBaseUrl pointing to blocked targets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;
    try {
      fs.writeFileSync(configPath, JSON.stringify({ validationBaseUrl: 'http://localhost:8080' }));
      const cfg = loadConfig();
      assert.equal(cfg.validationBaseUrl, DEFAULTS.validationBaseUrl);
    } finally {
      if (orig) process.env.WINNOW_CONFIG = orig;
      else delete process.env.WINNOW_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates config file with defaults if missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;

    try {
      assert.equal(fs.existsSync(configPath), false);
      const cfg = loadConfig();
      assert.ok(fs.existsSync(path.dirname(configPath)));
      assert.ok(fs.existsSync(configPath));
      assert.equal(cfg.port, DEFAULTS.port);
      // proxyFile resolved to absolute path
      assert.ok(cfg.proxyFile.endsWith('/proxies.txt'), `expected /proxies.txt suffix, got ${cfg.proxyFile}`);
    } finally {
      if (orig) process.env.WINNOW_CONFIG = orig;
      else delete process.env.WINNOW_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('accepts tcp-only as a valid validation mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;

    try {
      fs.writeFileSync(configPath, JSON.stringify({ validationMode: 'tcp-only' }));
      const cfg = loadConfig();
      assert.equal(cfg.validationMode, 'tcp-only');
    } finally {
      if (orig) process.env.WINNOW_CONFIG = orig;
      else delete process.env.WINNOW_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clamps healthCheckInterval out of range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;

    try {
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          healthCheckInterval: 0,
        }),
      );

      const cfg = loadConfig();
      assert.equal(cfg.healthCheckInterval, DEFAULTS.healthCheckInterval);

      fs.writeFileSync(
        configPath,
        JSON.stringify({
          healthCheckInterval: false,
        }),
      );

      const cfg2 = loadConfig();
      assert.equal(cfg2.healthCheckInterval, false);
    } finally {
      if (orig) process.env.WINNOW_CONFIG = orig;
      else delete process.env.WINNOW_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('updateConfig', () => {
  let configDir: string;
  let origWinnowConfig: string | undefined;

  before(() => {
    origWinnowConfig = process.env.WINNOW_CONFIG;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-config-test-'));
    process.env.WINNOW_CONFIG = path.join(configDir, 'config.json');
  });

  after(() => {
    if (origWinnowConfig) process.env.WINNOW_CONFIG = origWinnowConfig;
    else delete process.env.WINNOW_CONFIG;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('updates allowed keys', () => {
    const result = updateConfig({
      retries: 10,
      validationMode: 'strict',
    });
    assert.equal(result.retries, 10);
    assert.equal(result.validationMode, 'strict');
  });

  it('updates targets (allowed key)', () => {
    const result = updateConfig({
      targets: ['example.com:80'],
    });
    assert.deepEqual(result.targets, ['example.com:80']);
  });

  it('ignores disallowed keys', () => {
    // Reset config file to clean state (previous tests may have modified it)
    fs.writeFileSync(process.env.WINNOW_CONFIG!, '{}', 'utf8');
    const result = updateConfig({
      nonexistent: '/evil/path',
    } as unknown as Partial<RotatorConfig>);
    assert.equal(result.retries, DEFAULTS.retries);
  });

  it('sanitizes updated values', () => {
    const result = updateConfig({
      retries: -5,
      banBaseMs: -1,
    });
    assert.equal(result.retries, DEFAULTS.retries);
    assert.equal(result.banBaseMs, DEFAULTS.banBaseMs);
  });
});

describe('updateConfig health check', () => {
  let configDir: string;
  let origWinnowConfig: string | undefined;

  before(() => {
    origWinnowConfig = process.env.WINNOW_CONFIG;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-config-test-'));
    process.env.WINNOW_CONFIG = path.join(configDir, 'config.json');
  });

  after(() => {
    if (origWinnowConfig) process.env.WINNOW_CONFIG = origWinnowConfig;
    else delete process.env.WINNOW_CONFIG;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('healthCheckInterval can be set to false via updateConfig', () => {
    const result = updateConfig({
      healthCheckInterval: false,
    });
    assert.equal(result.healthCheckInterval, false);
  });

  it('healthCheckCount and healthCheckParallel are sanitized in updateConfig', () => {
    const result = updateConfig({
      healthCheckCount: 999,
      healthCheckParallel: false,
    });
    assert.equal(result.healthCheckCount, DEFAULTS.healthCheckCount);
    assert.equal(result.healthCheckParallel, false);
  });

  it('tick picks up new healthCheckInterval after config change (simulates scheduleNextHealthCheck logic)', () => {
    // Start from DEFAULTS (avoids shared config file pollution from sibling tests)
    const configRef: { current: RotatorConfig } = { current: { ...DEFAULTS } };
    const originalInterval = configRef.current.healthCheckInterval;
    assert.equal(originalInterval, 15000);

    // Change the interval via updateConfig (as POST /api/config does)
    const updated = updateConfig({ healthCheckInterval: 30000 }, { ...configRef.current });
    Object.assign(configRef.current, updated);
    assert.equal(configRef.current.healthCheckInterval, 30000);

    // Simulate scheduleNextHealthCheck interval resolution
    const interval = configRef.current.healthCheckInterval as number | false;
    const ms = interval === false ? 5000 : typeof interval === 'number' && interval > 0 ? interval : 15000;
    assert.equal(ms, 30000);
  });

  it('tick uses correct polling ms when healthCheckInterval is false', () => {
    const configRef: { current: RotatorConfig } = { current: { ...DEFAULTS } };
    const updated = updateConfig({ healthCheckInterval: false }, { ...configRef.current });

    // Manually apply — updateConfig returns the sanitized result
    const interval: number | false = updated.healthCheckInterval;
    const ms = interval === false ? 5000 : typeof interval === 'number' && interval > 0 ? interval : 15000;
    assert.equal(ms, 5000);
  });
});
