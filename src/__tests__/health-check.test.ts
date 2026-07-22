import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RotatorConfig } from '../config/index.js';
import type { HealthStore } from '../health/index.js';
import { healthCheckTick } from '../proxy/rotator.js';

const mockConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    healthCheckCount: 5,
    healthCheckParallel: false,
    maxErrors: 3,
    timeout: 2000,
    targets: ['test.example.com:80'],
    validationStrictTLS: false,
    ...overrides,
  }) as unknown as RotatorConfig;

const mockHealth = () =>
  ({
    isAlive: () => true,
    scoreProxy: () => 0,
    recordSuccess: () => {},
    recordFailure: () => {},
    on: () => {
      throw new Error('not implemented');
    },
    emit: () => {
      throw new Error('not implemented');
    },
  }) as unknown as HealthStore;

describe('healthCheckTick', () => {
  it('returns early when targets array is empty', async () => {
    await healthCheckTick([{ raw: '1.2.3.4:80', url: new URL('http://1.2.3.4:80'), proto: 'http' }], mockHealth(), mockConfig(), []);
  });

  it('returns early when target host:port cannot be parsed', async () => {
    await healthCheckTick([{ raw: '1.2.3.4:80', url: new URL('http://1.2.3.4:80'), proto: 'http' }], mockHealth(), mockConfig(), ['']);
  });

  it('serial mode handles empty proxies without throwing', async () => {
    await healthCheckTick([], mockHealth(), mockConfig({ healthCheckParallel: false }), ['test.example.com:80']);
  });

  it('parallel mode handles empty proxies without throwing', async () => {
    await healthCheckTick([], mockHealth(), mockConfig({ healthCheckParallel: true }), ['test.example.com:80']);
  });
});
