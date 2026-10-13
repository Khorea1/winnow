import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { DEFAULTS } from '../config/index.js';
import { registerDashboard, unsubscribeDashboard } from '../dashboard/index.js';
import { initDb } from '../db/index.js';
import { HealthStore } from '../health/index.js';

type Endpoint = { path: string; method: string };

function endpointKey({ method, path: route }: Endpoint): string {
  return `${method} ${route}`;
}

function documentedEndpoints(): Endpoint[] {
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../../README.md'), 'utf8');
  const section = readme.split('## API endpoints\n')[1]?.split('\n## ')[0];
  assert.ok(section, 'README must contain an API endpoints table');
  return [...section.matchAll(/^\|\s*`(\/[^`]*)`\s*\|\s*(GET|POST|DELETE)\s*\|/gm)].map((match) => ({
    path: match[1]!.split('?')[0]!,
    method: match[2]!,
  }));
}

function implementedEndpoints(): Endpoint[] {
  // The public contract is explicit. Source regexes silently miss handlers
  // delegated to route modules or routes that check the method separately.
  const routes: Record<'GET' | 'POST' | 'DELETE', string[]> = {
    GET: [
      '/',
      '/dashboard',
      '/dashboard.css',
      '/dashboard.js',
      '/dashboard-utils.js',
      '/__stats',
      '/metrics',
      '/api/config',
      '/api/events',
      '/events',
      '/api/validate',
      '/api/validate/status',
    ],
    POST: ['/api/config', '/api/validate', '/api/validate/stop'],
    DELETE: ['/api/proxy'],
  };
  return Object.entries(routes).flatMap(([method, paths]) => paths.map((route) => ({ path: route, method })));
}

describe('README API contract', () => {
  let tempDir: string;
  let previousDataDir: string | undefined;
  let previousToken: string | undefined;
  let db: Database.Database;
  let health: HealthStore;
  let server: http.Server;
  let base: string;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-readme-contract-'));
    previousDataDir = process.env.WINNOW_DATA_DIR;
    previousToken = process.env.WINNOW_TOKEN;
    process.env.WINNOW_DATA_DIR = tempDir;
    process.env.WINNOW_TOKEN = 'readme-contract-token';
    const proxyFile = path.join(tempDir, 'proxies.txt');
    fs.writeFileSync(proxyFile, '');
    db = initDb(':memory:');
    health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
    server = http.createServer();
    registerDashboard(server, { config: { current: { ...DEFAULTS, proxyFile } }, health, db });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    unsubscribeDashboard();
    health?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    db?.close();
    if (previousDataDir === undefined) delete process.env.WINNOW_DATA_DIR;
    else process.env.WINNOW_DATA_DIR = previousDataDir;
    if (previousToken === undefined) delete process.env.WINNOW_TOKEN;
    else process.env.WINNOW_TOKEN = previousToken;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('documents each dashboard API route and no nonexistent route', () => {
    const documented = documentedEndpoints().map(endpointKey).sort();
    const implemented = implementedEndpoints().map(endpointKey).sort();
    assert.equal(new Set(documented).size, documented.length, 'README contains duplicate method/path entries');
    assert.deepEqual(documented, implemented);
  });

  it('all documented endpoints respond as routed HTTP requests', async () => {
    for (const endpoint of documentedEndpoints()) {
      const { method, path: route } = endpoint;
      const controller = new AbortController();
      const malformed = method === 'POST' && route !== '/api/validate/stop';
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { authorization: 'Bearer readme-contract-token' },
        ...(malformed ? { body: '{' } : {}),
        signal: controller.signal,
      });
      const expected = malformed || (method === 'DELETE' && route === '/api/proxy') ? 400 : 200;
      assert.equal(response.status, expected, `${method} ${route}`);
      if (route === '/events') controller.abort();
      else await response.arrayBuffer();
    }
  });
});
