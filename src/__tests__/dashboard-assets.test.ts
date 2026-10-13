import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { DEFAULTS } from '../config/index.js';
import { readDashboardHtml, registerDashboard, unsubscribeDashboard } from '../dashboard/index.js';
import type { HealthStore } from '../health/index.js';

describe('dashboard HTML loading', () => {
  it('reloads the HTML from disk when caching is disabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-html-'));
    const file = path.join(dir, 'dashboard.html');
    try {
      fs.writeFileSync(file, '<html>first</html>');
      assert.equal(readDashboardHtml([file], false), '<html>first</html>');
      fs.writeFileSync(file, '<html>second</html>');
      assert.equal(readDashboardHtml([file], false), '<html>second</html>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves the browser module, its dependency, and the HTML module tag', async () => {
    const server = http.createServer();
    const health = Object.assign(new EventEmitter(), { entries: () => [], size: 0 }) as unknown as HealthStore;
    registerDashboard(server, { config: { current: { ...DEFAULTS } }, health, db: {} as Database.Database });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const script = await fetch(`${base}/dashboard.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type') ?? '', /javascript/);
      assert.match(await script.text(), /import \{ classifyProxy as classify, sortAndFilterProxies \}/);

      const dependency = await fetch(`${base}/dashboard-utils.js`);
      assert.equal(dependency.status, 200);
      assert.match(dependency.headers.get('content-type') ?? '', /javascript/);
      assert.match(await dependency.text(), /export function sortAndFilterProxies/);

      const token = process.env.WINNOW_TOKEN || process.env.DASHBOARD_TOKEN || process.env.API_TOKEN;
      const html = await fetch(`${base}/dashboard`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      assert.equal(html.status, 200);
      assert.match(await html.text(), /<script type="module" src="\/dashboard\.js"><\/script>/);
    } finally {
      unsubscribeDashboard();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
