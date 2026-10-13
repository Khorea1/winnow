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

// Covers registerDashboard over HTTP on an ephemeral port: auth matrix, CSP,
// DELETE 404, config allow-list, validate 409/stop, SSE client cap.
describe('dashboard routes', () => {
  let directory = '';
  let proxyFile = '';
  let previousDataDir: string | undefined;
  let previousToken: string | undefined;
  let db: Database.Database;
  let health: HealthStore;
  let server: http.Server;
  let base = '';
  const auth = { authorization: 'Bearer dashboard-test-token' };
  const requestMetrics = { requests: 3, successes: 2, failures: 1, bytes: 120, latencyMs: 45 };
  let forwardedRequests = 0;

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'winnow-dashboard-test-'));
    previousDataDir = process.env.WINNOW_DATA_DIR;
    process.env.WINNOW_DATA_DIR = directory;
    previousToken = process.env.WINNOW_TOKEN;
    process.env.WINNOW_TOKEN = 'dashboard-test-token';
    proxyFile = path.join(directory, 'proxies.txt');
    // Dead proxies fail at TCP stage (no external network); throttle stretches runs.
    fs.writeFileSync(proxyFile, 'http://127.0.0.1:9\nhttp://127.0.0.1:10\n');
    db = initDb(':memory:');
    health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
    server = http.createServer();
    server.on('request', (_req, res) => {
      forwardedRequests++;
      res.writeHead(202);
      res.end('proxy handler');
    });
    registerDashboard(server, {
      config: { current: { ...DEFAULTS, proxyFile } },
      health,
      db,
      getRequestMetrics: () => requestMetrics,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    unsubscribeDashboard();
    health?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db?.close();
    if (previousDataDir === undefined) delete process.env.WINNOW_DATA_DIR;
    else process.env.WINNOW_DATA_DIR = previousDataDir;
    if (previousToken === undefined) delete process.env.WINNOW_TOKEN;
    else process.env.WINNOW_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects unauthenticated dashboard, assets, and API', async () => {
    for (const p of ['/dashboard', '/dashboard.js', '/dashboard.css', '/dashboard-utils.js', '/api/validate/status', '/__stats', '/metrics']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 401, p);
      await res.arrayBuffer();
    }
  });

  it('accepts the Bearer token and rejects wrong/prefix tokens', async () => {
    for (const p of ['/dashboard.js', '/dashboard-utils.js']) {
      const ok = await fetch(`${base}${p}`, { headers: auth });
      assert.equal(ok.status, 200, p);
      await ok.arrayBuffer();
    }
    for (const bad of ['Bearer wrong', 'Bearer dashboard-test-toke', 'Bearer dashboard-test-token-x']) {
      const res = await fetch(`${base}/dashboard.js`, { headers: { authorization: bad } });
      assert.equal(res.status, 401, bad);
      await res.arrayBuffer();
    }
  });

  it('serves CSP with frame-ancestors on /dashboard', async () => {
    const res = await fetch(`${base}/dashboard`, { headers: auth });
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("frame-ancestors 'self'"), csp);
    await res.arrayBuffer();
  });

  it('includes the request metrics aggregate in /__stats', async () => {
    const res = await fetch(`${base}/__stats`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { requestMetrics: typeof requestMetrics; connections: { active: number; limit: number; rejected: number } };
    assert.deepEqual(body.requestMetrics, requestMetrics);
    assert.deepEqual(body.connections, { active: 0, limit: DEFAULTS.maxConnections, rejected: 0 });
  });
  it('exports bounded Prometheus metrics with the dashboard authentication policy', async () => {
    const res = await fetch(`${base}/metrics`, { headers: auth });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/plain; version=0\.0\.4/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.match(body, /^# TYPE winnow_proxy_pool_total gauge$/m);
    assert.match(body, /^winnow_proxy_pool_total 0$/m);
    assert.match(body, /^winnow_proxy_pool_healthy 0$/m);
    assert.match(body, /^winnow_connections_active 0$/m);
    assert.match(body, /^winnow_connections_limit 1000$/m);
    assert.match(body, /^winnow_connection_rejections_total 0$/m);
    assert.match(body, /^winnow_requests_total\{result="success"\} 2$/m);
    assert.match(body, /^winnow_requests_total\{result="failure"\} 1$/m);
    assert.match(body, /^winnow_request_bytes_total 120$/m);
    assert.match(body, /^winnow_request_latency_milliseconds_sum 45$/m);
    assert.doesNotMatch(body, /127\.0\.0\.1|dashboard-test-token/);

    const methodNotAllowed = await fetch(`${base}/metrics`, { method: 'POST', headers: auth });
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(methodNotAllowed.headers.get('allow'), 'GET');
    await methodNotAllowed.arrayBuffer();
  });
  it('dispatches dashboard routes exclusively and forwards other requests to the proxy once', async () => {
    const before = forwardedRequests;
    const [stats, unauthorized, admin] = await Promise.all([
      fetch(`${base}/__stats`, { headers: auth }),
      fetch(`${base}/__stats`),
      fetch(`${base}/api/validate/status`, { headers: auth }),
    ]);
    assert.deepEqual([stats.status, unauthorized.status, admin.status], [200, 401, 200]);
    await Promise.all([stats.arrayBuffer(), unauthorized.arrayBuffer(), admin.arrayBuffer()]);
    assert.equal(forwardedRequests, before);

    const forwarded = await fetch(`${base}/ordinary-traffic`);
    assert.equal(forwarded.status, 202);
    assert.equal(await forwarded.text(), 'proxy handler');
    assert.equal(forwardedRequests, before + 1);
  });
  it('DELETE unknown proxy returns 404', async () => {
    const res = await fetch(`${base}/api/proxy?key=${encodeURIComponent('http://9.9.9.9:8080')}`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });

  it('POST /api/config applies the allow-list and drops unknown fields', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ validationThreads: 7, notARealField: 123 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { validationThreads?: unknown; notARealField?: unknown };
    assert.equal(body.validationThreads, 7);
    assert.equal(body.notARealField, undefined);
  });

  it('second concurrent validation run returns 409 and stop aborts', { timeout: 15000 }, async () => {
    const first = await fetch(`${base}/api/validate`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ threads: 1, throttle: 1500 }),
    });
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const second = await fetch(`${base}/api/validate`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(second.status, 409);
    await second.arrayBuffer();
    const stopped = await fetch(`${base}/api/validate/stop`, { method: 'POST', headers: auth });
    assert.deepEqual(await stopped.json(), { stopped: true });
    let running = true;
    for (let i = 0; i < 50 && running; i++) {
      const status = await fetch(`${base}/api/validate/status`, { headers: auth });
      running = ((await status.json()) as { running: boolean }).running;
      if (running) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(running, false);
  });

  it('removes a proxy atomically while preserving comments and blank lines', async () => {
    const original = '# retained\n\nhttp://127.0.0.1:9\nhttp://127.0.0.1:10\n';
    fs.writeFileSync(proxyFile, original);

    const res = await fetch(`${base}/api/proxy?key=${encodeURIComponent('http://127.0.0.1:9')}`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();

    assert.equal(fs.readFileSync(proxyFile, 'utf8'), '# retained\n\nhttp://127.0.0.1:10\n');
  });

  it('101st SSE client is rejected with 503', { timeout: 15000 }, async () => {
    const controllers: AbortController[] = [];
    try {
      const opened = [];
      for (let i = 0; i < 100; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        opened.push(fetch(`${base}/events`, { headers: auth, signal: controller.signal }));
      }
      const responses = await Promise.all(opened);
      for (const res of responses) assert.equal(res.status, 200);
      const extra = await fetch(`${base}/events`, { headers: auth });
      assert.equal(extra.status, 503);
      await extra.arrayBuffer();
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });
});
