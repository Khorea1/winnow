import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { after, it } from 'node:test';
import { DEFAULTS } from '../config/index.js';
import { registerDashboard, unsubscribeDashboard } from '../dashboard/index.js';
import { initDb } from '../db/index.js';
import { blankEntry, HealthStore } from '../health/index.js';

const servers: http.Server[] = [];
const directories: string[] = [];
const proxySockets = new Set<Duplex>();

after(async () => {
  unsubscribeDashboard();
  for (const socket of proxySockets) socket.destroy();
  await Promise.all(
    servers.map((server) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      server.closeAllConnections();
      return promise;
    }),
  );
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

it('cancelled validation leaves existing proxy health unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-validation-cancel-'));
  directories.push(directory);
  const previousDataDir = process.env.WINNOW_DATA_DIR;
  process.env.WINNOW_DATA_DIR = directory;

  const proxyFile = path.join(directory, 'proxies.txt');
  const db = initDb(':memory:');
  const health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
  const proxyServer = http.createServer();
  servers.push(proxyServer);
  const { promise: connected, resolve: connectReceived } = Promise.withResolvers<void>();
  proxyServer.on('connect', (_req, socket) => {
    proxySockets.add(socket);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => connectReceived());
  });
  const { promise: proxyListening, resolve: proxyReady } = Promise.withResolvers<number>();
  proxyServer.listen(0, '127.0.0.1', () => proxyReady((proxyServer.address() as net.AddressInfo).port));
  const proxyPort = await proxyListening;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  fs.writeFileSync(proxyFile, `${proxyUrl}\n`);
  const priorHealth = { ...blankEntry(), errors: 2, successes: 4, latency: 123, bannedUntil: 0, lastOk: 456 };
  health.set(proxyUrl, { ...priorHealth });

  const dashboard = http.createServer();
  servers.push(dashboard);
  registerDashboard(dashboard, {
    config: { current: { ...DEFAULTS, proxyFile, validationMode: 'quick', validationPrune: false, validationThrottle: 0 } },
    health,
    db,
  });
  const { promise: dashboardListening, resolve: dashboardReady } = Promise.withResolvers<number>();
  dashboard.listen(0, '127.0.0.1', () => dashboardReady((dashboard.address() as net.AddressInfo).port));
  const dashboardPort = await dashboardListening;

  try {
    const baseUrl = `http://127.0.0.1:${dashboardPort}`;
    const start = await fetch(`${baseUrl}/api/validate`, { method: 'POST', body: '{}' });
    assert.equal(start.status, 200);
    await connected;
    const stopped = await fetch(`${baseUrl}/api/validate/stop`, { method: 'POST' });
    assert.deepEqual(await stopped.json(), { stopped: true });

    let running = true;
    for (let attempt = 0; attempt < 20 && running; attempt++) {
      const status = await fetch(`${baseUrl}/api/validate/status`);
      running = ((await status.json()) as { running: boolean }).running;
    }
    assert.equal(running, false, 'validation should finish after cancellation');
    assert.deepEqual(health.get(proxyUrl), priorHealth);
    assert.equal(health.has(proxyUrl), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.WINNOW_DATA_DIR;
    else process.env.WINNOW_DATA_DIR = previousDataDir;
    db.close();
  }
});
