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
  return [...section.matchAll(/^\|\s*`(\/[^`]+)`\s*\|\s*(GET|POST|DELETE)\s*\|/gm)].map((match) => ({
    path: match[1].split('?')[0],
    method: match[2],
  }));
}

function implementedEndpoints(): Endpoint[] {
  // Scan the route conditions, including any extracted dashboard route modules.
  const files = [path.resolve(import.meta.dirname, '../dashboard/index.ts')];
  const routesDir = path.resolve(import.meta.dirname, '../dashboard/routes');
  if (fs.existsSync(routesDir)) {
    for (const entry of fs.readdirSync(routesDir)) {
      if (entry.endsWith('.ts')) files.push(path.join(routesDir, entry));
    }
  }

  const routes: Endpoint[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/if\s*\(pathname\s*===\s*'([^']+)'(?:\s*&&\s*req\.method\s*===\s*'(GET|POST|DELETE)')?\)/g)) {
      const route = match[1];
      if (route.startsWith('/api/') || ['/dashboard', '/events', '/__stats'].includes(route)) {
        routes.push({ path: route, method: match[2] ?? 'GET' });
      }
    }
  }
  return routes;
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
        body: malformed ? '{' : undefined,
        signal: controller.signal,
      });
      const expected = malformed || (method === 'DELETE' && route === '/api/proxy') ? 400 : 200;
      assert.equal(response.status, expected, `${method} ${route}`);
      if (route === '/events') controller.abort();
      else await response.arrayBuffer();
    }
  });
});
