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

  it('creates config file with defaults if missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-test-'));
    const configPath = path.join(dir, 'config.json');
    const orig = process.env.WINNOW_CONFIG;
    process.env.WINNOW_CONFIG = configPath;

    try {
      assert.equal(fs.existsSync(configPath), false);
      const cfg = loadConfig();
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
});

describe('updateConfig', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-config-test-'));

  before(() => {
    process.env.WINNOW_CONFIG = path.join(tmpDir, 'config.json');
  });

  after(() => {
    delete process.env.WINNOW_CONFIG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates allowed keys', () => {
    const result = updateConfig({
      port: 9090,
      retries: 10,
      validationMode: 'strict',
    });
    assert.equal(result.port, 9090);
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
