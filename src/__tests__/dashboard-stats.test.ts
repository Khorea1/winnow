import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { it } from 'node:test';
import { DEFAULTS } from '../config/index.js';
import { registerDashboard, unsubscribeDashboard } from '../dashboard/index.js';
import { initDb } from '../db/index.js';
import { HealthStore } from '../health/index.js';
import { applyServerTimeouts, createProxyServer } from '../proxy/server.js';

it('exposes upstream metrics and hot-reloads timeouts and the connection cap', { timeout: 5000 }, async () => {
  const db = initDb(':memory:');
  const cfgRef = { current: { ...DEFAULTS, proxyFile: '' } };
  const health = new HealthStore(db, cfgRef.current);
  const server = createProxyServer({ config: cfgRef, health, getProxies: () => [] });
  const stats = { requests: 2, successes: 1, failures: 1, bytes: 512, latencyMs: 20 };
  registerDashboard(server, {
    config: cfgRef,
    health,
    db,
    getRequestMetrics: () => ({ ...stats }),
    onConfigChange: (updated) => applyServerTimeouts(server, updated),
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    async function request(path: string, method = 'GET', body?: string): Promise<{ status: number; json: Record<string, unknown> }> {
      const token = process.env.WINNOW_TOKEN || process.env.DASHBOARD_TOKEN || process.env.API_TOKEN;
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk: Buffer) => {
              text += chunk.toString();
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    }

    const initial = await request('/__stats');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json.requestMetrics, stats);
    const updated = await request('/api/config', 'POST', JSON.stringify({ timeout: 45000, maxConnections: 2 }));
    assert.equal(updated.status, 200);
    assert.equal(updated.json.maxConnections, 2);
    assert.equal(server.timeout, 45000);
    assert.equal(server.keepAliveTimeout, 30000);
  } finally {
    unsubscribeDashboard();
    health.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
