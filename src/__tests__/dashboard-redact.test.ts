import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { loadConfig } from '../config/index.js';
import { registerDashboard, unsubscribeDashboard } from '../dashboard/index.js';
import { initDb } from '../db/index.js';
import { EventLog } from '../events.js';
import { HealthStore } from '../health/index.js';

it('dashboard SSE and HTTP responses do not expose proxy credentials', async () => {
  const db = initDb(':memory:');
  const eventLog = new EventLog();
  const health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300000 }, eventLog);
  const server = http.createServer();
  const abort = new AbortController();
  registerDashboard(server, { config: { current: loadConfig() }, db, health, eventLog });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = process.env.WINNOW_TOKEN || process.env.DASHBOARD_TOKEN || process.env.API_TOKEN;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${baseUrl}/events`, { headers, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await reader.read(); // Initial SSE connected event.

    const proxy = 'socks5://alice:secret@proxy.example:1080';
    health.recordSuccess(proxy, 'example.com:443', 100);
    eventLog.push({ type: 'connect', proxy, target: 'example.com:443', status: 'success' });

    let received = '';
    const timeout = setTimeout(() => abort.abort(), 3000);
    try {
      while (!received.includes('event: health:update') || !received.includes('event: proxy:event')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += new TextDecoder().decode(chunk.value);
      }
    } finally {
      clearTimeout(timeout);
    }

    const [events, stats] = await Promise.all([
      fetch(`${baseUrl}/api/events`, { headers }).then((res) => res.text()),
      fetch(`${baseUrl}/__stats`, { headers }).then((res) => res.text()),
    ]);
    for (const payload of [received, events, stats]) {
      assert.ok(payload.includes('proxy.example:1080'));
      assert.ok(!payload.includes('alice'));
      assert.ok(!payload.includes('secret'));
    }
    assert.ok(health.has(proxy));
  } finally {
    abort.abort();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    unsubscribeDashboard();
    health.stop();
    db.close();
  }
});
