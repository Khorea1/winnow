import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULTS } from '../config/index.js';
import { respondJson } from '../dashboard/http.js';
import { registerDashboard, unsubscribeDashboard } from '../dashboard/index.js';
import { handleValidateRoute } from '../dashboard/routes/validate.js';
import type { DashboardRouteContext, ValidationOverrides } from '../dashboard/types.js';
import { EventLog } from '../events.js';
import { blankEntry, HealthStore } from '../health/index.js';

test('dashboard routes retain auth, SSE, config, stats, validation and atomic proxy deletion', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-dashboard-'));
  const proxyFile = path.join(temp, 'proxies.txt');
  const raw = 'http://alice:secret@203.0.113.5:8080';
  const other = 'http://203.0.113.6:8080';
  fs.writeFileSync(proxyFile, `# preserve me\n${raw}\n\n${other}\n`);
  const previousDataDir = process.env.WINNOW_DATA_DIR;
  const previousToken = process.env.WINNOW_TOKEN;
  const previousDashboardToken = process.env.DASHBOARD_TOKEN;
  const previousApiToken = process.env.API_TOKEN;
  process.env.WINNOW_DATA_DIR = temp;
  delete process.env.WINNOW_TOKEN;
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.API_TOKEN;

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE proxy_health (
      proxy TEXT NOT NULL, target TEXT NOT NULL DEFAULT '*',
      errors INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
      latency INTEGER NOT NULL DEFAULT 9999, banned_until INTEGER NOT NULL DEFAULT 0,
      last_ok INTEGER NOT NULL DEFAULT 0, fatal_errors INTEGER NOT NULL DEFAULT 0,
      frozen_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (proxy, target)
    );
    CREATE TABLE validation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER NOT NULL, finished INTEGER,
      total INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, exit_code INTEGER
    );
  `);
  const eventLog = new EventLog();
  const health = new HealthStore(db, DEFAULTS, eventLog);
  const config = { current: { ...DEFAULTS, proxyFile } };
  const server = http.createServer();
  registerDashboard(server, { config, health, db, eventLog });
  let guardServer: http.Server | undefined;

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;

    const configResponse = await fetch(`${base}/api/config`);
    assert.equal(configResponse.status, 200);
    assert.equal(((await configResponse.json()) as { proxyFile: string }).proxyFile, proxyFile);

    const update = await fetch(`${base}/api/config`, {
      method: 'POST',
      body: JSON.stringify({ retries: 2, port: 12345 }),
    });
    assert.equal(update.status, 200);
    assert.equal(((await update.json()) as { retries: number }).retries, 2);
    assert.equal(config.current.port, DEFAULTS.port);

    health.set(raw, blankEntry());
    const stats = (await (await fetch(`${base}/__stats`)).json()) as { total: number; alive: number; top: { proxy: string }[] };
    assert.equal(stats.total, 1);
    assert.equal(stats.alive, 1);
    assert.equal(stats.top[0]?.proxy, '203.0.113.5:8080');
    assert.equal(JSON.stringify(stats).includes('secret'), false);

    const recent = (await (await fetch(`${base}/api/events`)).json()) as { events: unknown[] };
    assert.ok(Array.isArray(recent.events));

    const sse = await fetch(`${base}/events`);
    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get('content-type'), 'text/event-stream');
    assert.ok(sse.body);
    const reader = sse.body.getReader();
    const connected = await reader.read();
    assert.match(new TextDecoder().decode(connected.value), /event: connected/);
    health.emit('health:update', { proxy: 'test' });
    const pushed = await reader.read();
    assert.match(new TextDecoder().decode(pushed.value), /event: health:update/);
    await reader.cancel();

    const deleted = await fetch(`${base}/api/proxy`, {
      method: 'DELETE',
      headers: { 'X-Proxy-Key': raw },
    });
    assert.equal(deleted.status, 200);
    const result = (await deleted.json()) as { removed: boolean; key: string; removedFromFile: boolean; removedFromHealth: boolean };
    assert.deepEqual(
      { removed: result.removed, key: result.key, removedFromFile: result.removedFromFile, removedFromHealth: result.removedFromHealth },
      { removed: true, key: '203.0.113.5:8080', removedFromFile: true, removedFromHealth: true },
    );
    assert.equal(health.has(raw), false);
    assert.equal(fs.readFileSync(proxyFile, 'utf8'), `# preserve me\n\n${other}\n`);
    assert.equal((await fetch(`${base}/api/proxy`, { method: 'DELETE', headers: { 'X-Proxy-Key': raw } })).status, 404);

    assert.deepEqual(await (await fetch(`${base}/api/validate`)).json(), []);
    assert.deepEqual(await (await fetch(`${base}/api/validate/status`)).json(), { running: false });
    assert.deepEqual(await (await fetch(`${base}/api/validate/stop`, { method: 'POST' })).json(), { stopped: false, reason: 'not running' });
    assert.equal((await fetch(`${base}/api/validate`, { method: 'POST', body: '{bad-json' })).status, 400);
    assert.equal((await fetch(`${base}/api/validate`, { method: 'POST', body: 'x'.repeat(33000) })).status, 413);

    let normalized: Partial<ValidationOverrides> | undefined;
    guardServer = http.createServer();
    const routeCtx: DashboardRouteContext = {
      config,
      health,
      db,
      eventLog,
      server: guardServer,
      sseClients: new Set(),
      validation: {
        start: async (res, custom) => {
          normalized = custom;
          respondJson(res, { accepted: true });
        },
        stop: () => {},
        abort: () => {},
        isRunning: () => false,
      },
    };
    guardServer.on('request', (req, res) => {
      void handleValidateRoute(req, res, new URL(req.url || '/', 'http://localhost'), routeCtx);
    });
    await new Promise<void>((resolve) => guardServer!.listen(0, '127.0.0.1', resolve));
    const guardAddress = guardServer.address();
    assert.ok(guardAddress && typeof guardAddress !== 'string');
    const guarded = await fetch(`http://127.0.0.1:${guardAddress.port}/api/validate`, {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1/',
        tlsHost: 'localhost',
        threads: 999,
        connectTimeout: 99,
        tlsPort: 99999,
        mode: 'unsupported',
      }),
    });
    assert.equal(guarded.status, 200);
    assert.deepEqual(normalized, { threads: 200, connectTimeout: 60, tlsPort: 65535 });

    process.env.WINNOW_TOKEN = 'dashboard-secret';
    assert.equal((await fetch(`${base}/api/config`)).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { headers: { Authorization: 'Bearer dashboard-secret' } })).status, 200);
  } finally {
    unsubscribeDashboard();
    if (guardServer) {
      guardServer.closeAllConnections();
      await new Promise<void>((resolve) => guardServer!.close(() => resolve()));
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    health.stop();
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.WINNOW_DATA_DIR;
    else process.env.WINNOW_DATA_DIR = previousDataDir;
    if (previousToken === undefined) delete process.env.WINNOW_TOKEN;
    else process.env.WINNOW_TOKEN = previousToken;
    if (previousDashboardToken === undefined) delete process.env.DASHBOARD_TOKEN;
    else process.env.DASHBOARD_TOKEN = previousDashboardToken;
    if (previousApiToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = previousApiToken;
  }
});
