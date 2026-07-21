import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULTS } from '../config/index.js';
import { blankEntry, HealthStore } from '../health/index.js';
import type { ParsedProxy } from '../proxy/dial.js';
import { createProxyServer } from '../proxy/server.js';

/**
 * Hostname used as the target in tests. Not blocked by SSRF (not a private IP
 * literal, not localhost, not *.local/ *.internal). The upstream proxy
 * intercepts this hostname and connects to 127.0.0.1.
 */
const TARGET_HOST = 'winnow-test-target';
const BASE_CONFIG = {
  ...DEFAULTS,
  port: 0,
  proxyFile: '',
  targets: [],
  retries: 3,
  timeout: 3000,
  upstreamIdleTimeout: 5000,
  pruneAfterMs: 0,
  validationBaseUrl: '',
  validationTlsHost: '',
};

function proxyFromUrl(raw: string): ParsedProxy {
  const url = new URL(raw);
  return { raw, url, proto: url.protocol === 'socks5:' ? 'socks5' : 'http' };
}

function listen(server: http.Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  return promise;
}

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS proxy_health (
    proxy  TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '*',
    errors INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    latency INTEGER NOT NULL DEFAULT 9999,
    banned_until INTEGER NOT NULL DEFAULT 0,
    last_ok INTEGER NOT NULL DEFAULT 0,
    fatal_errors INTEGER NOT NULL DEFAULT 0,
    frozen_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (proxy, target)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS validation_runs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    started   INTEGER NOT NULL,
    finished  INTEGER,
    total     INTEGER NOT NULL DEFAULT 0,
    passed    INTEGER NOT NULL DEFAULT 0,
    failed    INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER
  );`);
  return db;
}

/**
 * Start a minimal HTTP forward proxy that accepts CONNECT to any host:port.
 * Used as an upstream proxy in the pool.
 */
function startUpstreamProxy(): Promise<{ server: http.Server; port: number }> {
  const { promise, resolve } = Promise.withResolvers<{
    server: http.Server;
    port: number;
  }>();
  const server = http.createServer();
  server.on('connect', (req, clientSock, head) => {
    const url = req.url || '';
    const lastColon = url.lastIndexOf(':');
    if (lastColon === -1) {
      clientSock.end();
      return;
    }
    const host = url.slice(0, lastColon);
    const port = parseInt(url.slice(lastColon + 1), 10) || 80;
    const connectHost = host === TARGET_HOST ? '127.0.0.1' : host;
    const targetSock = net.connect(port, connectHost, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) targetSock.write(head);
      targetSock.pipe(clientSock);
      clientSock.pipe(targetSock);
    });
    const cleanup = () => {
      try {
        clientSock.destroy();
      } catch {}
      try {
        targetSock.destroy();
      } catch {}
    };
    targetSock.on('error', cleanup);
    clientSock.on('error', cleanup);
    clientSock.on('close', cleanup);
    targetSock.on('close', cleanup);
  });
  server.listen(0, '127.0.0.1', () => {
    resolve({ server, port: (server.address() as net.AddressInfo).port });
  });
  return promise;
}

/**
 * Send an HTTP request through the proxy and return the response body.
 */
function httpGetThroughProxy(proxyPort: number, targetHost: string, targetPort: number, path: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const req = http.request(
    {
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: `http://${targetHost}:${targetPort}${path}`,
      agent: false,
    },
    (res) => {
      let data = '';
      res.on('data', (c: Buffer) => {
        data += c.toString();
      });
      res.on('end', () => resolve(data));
    },
  );
  req.on('error', reject);
  req.end();
  return promise;
}

/**
 * Open a CONNECT tunnel through the proxy and return the HTTP status line.
 */
function connectCheck(proxyPort: number, host: string, port: number): Promise<{ status: string }> {
  const { promise, resolve } = Promise.withResolvers<{ status: string }>();
  const sock = net.connect(proxyPort, '127.0.0.1', () => {
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\n\r\n`);
  });
  let response = '';
  sock.on('data', (data: Buffer) => {
    response += data.toString();
    const firstLine = response.split('\r\n')[0];
    if (firstLine) {
      sock.destroy();
      resolve({ status: firstLine });
    }
  });
  sock.on('error', () => resolve({ status: '403' }));
  sock.on('end', () => resolve({ status: response.split('\r\n')[0] || '403' }));
  return promise;
}

// ── HTTP GET through pool ──────────────────────────────────

describe('proxy server', () => {
  describe('HTTP GET through pool', () => {
    let target: http.Server;
    let targetPort: number;
    let upstream: http.Server;
    let upstreamPort: number;
    let proxy: http.Server;
    let proxyPort: number;
    let health: HealthStore;
    let db: Database.Database;

    before(async () => {
      // Target echo server
      target = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c.toString();
        });
        req.on('end', () => {
          const data = JSON.stringify({ ok: true, method: req.method, path: req.url, body });
          const buf = Buffer.from(data, 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': buf.length.toString(),
          });
          res.end(buf);
        });
      });
      targetPort = await listen(target);

      // Upstream proxy
      const up = await startUpstreamProxy();
      upstream = up.server;
      upstreamPort = up.port;

      // Health store
      db = createDb();
      health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
      const proxyUrl = `http://127.0.0.1:${upstreamPort}`;
      health.set(proxyUrl, blankEntry());

      // Winnow proxy (system under test)
      proxy = createProxyServer({
        config: { current: { ...BASE_CONFIG } },
        health,
        getProxies: () => [proxyFromUrl(proxyUrl)],
      });
      proxyPort = await listen(proxy);
    });
    after(() => {
      health?.stop();
      proxy?.close();
      upstream?.close();
      target?.close();
      db?.close();
    });
    it('forwards HTTP GET request through pool', { timeout: 5000 }, async () => {
      const body = await httpGetThroughProxy(proxyPort, TARGET_HOST, targetPort, '/test');
      const parsed = JSON.parse(body);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.method, 'GET');
      assert.equal(parsed.path, '/test');
    });
  });

  // ── CONNECT tunnel ───────────────────────────────────────

  describe('CONNECT tunnel', () => {
    let target: net.Server;
    let targetPort: number;
    let upstream: http.Server;
    let upstreamPort: number;
    let proxy: http.Server;
    let proxyPort: number;
    let health: HealthStore;
    let db: Database.Database;

    before(async () => {
      // TCP echo target
      target = net.createServer((sock) => {
        sock.on('data', (data) => sock.write(data));
        sock.on('error', () => {});
      });
      const { promise: targetListenPromise, resolve: resolveTarget } = Promise.withResolvers<number>();
      target.listen(0, '127.0.0.1', () => resolveTarget((target.address() as net.AddressInfo).port));
      targetPort = await targetListenPromise;
      const up = await startUpstreamProxy();
      upstream = up.server;
      upstreamPort = up.port;

      // Health store
      db = createDb();
      health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
      const proxyUrl = `http://127.0.0.1:${upstreamPort}`;
      health.set(proxyUrl, blankEntry());

      // Winnow proxy
      proxy = createProxyServer({
        config: { current: { ...BASE_CONFIG } },
        health,
        getProxies: () => [proxyFromUrl(proxyUrl)],
      });
      proxyPort = await listen(proxy);
    });

    after(() => {
      health?.stop();
      proxy?.close();
      upstream?.close();
      target?.close();
      db?.close();
    });

    it('establishes CONNECT tunnel and proxies data', { timeout: 5000 }, async () => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write(`CONNECT ${TARGET_HOST}:${targetPort} HTTP/1.1\r\n\r\n`);
      });

      // Read the CONNECT response
      const { promise: responsePromise, resolve: resolveResponse, reject: rejectResponse } = Promise.withResolvers<void>();
      let response = '';
      const onRespData = (data: Buffer) => {
        response += data.toString();
        if (response.includes('\r\n\r\n')) {
          sock.removeListener('data', onRespData);
          resolveResponse();
        }
      };
      sock.on('data', onRespData);
      sock.on('error', rejectResponse);
      await responsePromise;

      assert.match(response, /HTTP\/1\.1 200/);

      // Send data through the tunnel
      const testPayload = Buffer.from('hello-tunnel-data');
      sock.write(testPayload);

      // Read echo back
      const { promise: echoPromise, resolve: resolveEcho } = Promise.withResolvers<Buffer>();
      sock.once('data', (data: Buffer) => resolveEcho(data));
      const echo = await echoPromise;

      assert.ok(echo.equals(testPayload));
      sock.destroy();
    });
  });

  // ── SSRF blocking ─────────────────────────────────────────

  describe('SSRF blocking', () => {
    let proxy: http.Server;
    let proxyPort: number;
    let health: HealthStore;
    let db: Database.Database;

    before(async () => {
      db = createDb();
      health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
      proxy = createProxyServer({
        config: { current: { ...BASE_CONFIG } },
        health,
        getProxies: () => [],
      });
      proxyPort = await listen(proxy);
    });

    after(() => {
      health?.stop();
      proxy?.close();
      db?.close();
    });

    it('blocks CONNECT to 127.0.0.1', { timeout: 5000 }, async () => {
      const { status } = await connectCheck(proxyPort, '127.0.0.1', 9999);
      assert.match(status, /403/);
    });

    it('blocks CONNECT to localhost', { timeout: 5000 }, async () => {
      const { status } = await connectCheck(proxyPort, 'localhost', 9999);
      assert.match(status, /403/);
    });

    it('blocks CONNECT to 10.0.0.1', { timeout: 5000 }, async () => {
      const { status } = await connectCheck(proxyPort, '10.0.0.1', 80);
      assert.match(status, /403/);
    });
  });

  // ── Proxy retry/fallback ──────────────────────────────────

  describe('proxy retry and fallback', () => {
    let target: http.Server;
    let targetPort: number;
    let upstream: http.Server;
    let upstreamPort: number;
    let deadProxyUrl: string;
    let workingProxyUrl: string;
    let proxy: http.Server;
    let proxyPort: number;
    let health: HealthStore;
    let db: Database.Database;

    before(async () => {
      target = http.createServer((_req, res) => {
        const buf = Buffer.from('ok', 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': buf.length.toString(),
        });
        res.end(buf);
      });
      targetPort = await listen(target);

      // Working upstream proxy
      const up = await startUpstreamProxy();
      upstream = up.server;
      upstreamPort = up.port;

      // Health store
      db = createDb();
      health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });

      deadProxyUrl = 'http://127.0.0.1:19999';
      workingProxyUrl = `http://127.0.0.1:${upstreamPort}`;

      // Dead proxy has a better score (low latency) → tried first
      const deadEntry = blankEntry();
      deadEntry.latency = 9999;
      health.set(deadProxyUrl, deadEntry);

      // Working proxy has worse score (high latency) → tried second
      const workingEntry = blankEntry();
      workingEntry.latency = 50_000;
      health.set(workingProxyUrl, workingEntry);

      // Winnow proxy with both upstreams
      proxy = createProxyServer({
        config: { current: { ...BASE_CONFIG, retries: 3, timeout: 2000 } },
        health,
        getProxies: () => [proxyFromUrl(deadProxyUrl), proxyFromUrl(workingProxyUrl)],
      });
      proxyPort = await listen(proxy);
    });

    after(() => {
      health?.stop();
      proxy?.close();
      upstream?.close();
      target?.close();
      db?.close();
    });

    it('falls back to working proxy when first proxy fails', { timeout: 10_000 }, async () => {
      const body = await httpGetThroughProxy(proxyPort, TARGET_HOST, targetPort, '/');
      assert.equal(body, 'ok');

      const workingEntry = health.get(workingProxyUrl);
      assert.ok(workingEntry);
      assert.equal(workingEntry!.successes, 1, 'working proxy should have exactly 1 success');
    });
  });

  describe('health scoring integration', () => {
    let target: http.Server;
    let targetPort: number;
    let upstream: http.Server;
    let upstreamPort: number;
    let proxyUrl: string;
    let proxy: http.Server;
    let proxyPort: number;
    let health: HealthStore;
    let db: Database.Database;

    before(async () => {
      // Target
      target = http.createServer((_req, res) => {
        const buf = Buffer.from('ok', 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': buf.length.toString(),
        });
        res.end(buf);
      });
      targetPort = await listen(target);

      // Upstream proxy
      const up = await startUpstreamProxy();
      upstream = up.server;
      upstreamPort = up.port;

      // Health store
      db = createDb();
      health = new HealthStore(db, { pruneAfterMs: 0, fatalBanMs: 300_000 });
      proxyUrl = `http://127.0.0.1:${upstreamPort}`;
      health.set(proxyUrl, blankEntry());

      // Winnow proxy
      proxy = createProxyServer({
        config: { current: { ...BASE_CONFIG } },
        health,
        getProxies: () => [proxyFromUrl(proxyUrl)],
      });
      proxyPort = await listen(proxy);
    });

    after(() => {
      health?.stop();
      proxy?.close();
      upstream?.close();
      target?.close();
      db?.close();
    });

    it('records success after a successful request', { timeout: 5000 }, async () => {
      const entryBefore = health.get(proxyUrl);
      assert.ok(entryBefore, 'should have initial entry');
      await httpGetThroughProxy(proxyPort, TARGET_HOST, targetPort, '/');
      const entryAfter = health.get(proxyUrl)!;
      // On a fresh proxy (latency 9999, successes 0) the first success updates
      // latency to the dial latency, increments successes, and sets lastOk.
      assert.ok(entryAfter.successes >= 1, 'successes should increment');
      assert.ok(entryAfter.lastOk > 0, 'lastOk should be set');
    });

    it('records failure when upstream is unreachable', { timeout: 15_000 }, async () => {
      const badUrl = 'http://127.0.0.1:19998';
      const badEntry = blankEntry();
      badEntry.latency = 9999;
      health.set(badUrl, badEntry);

      // Separate proxy server with only the bad upstream
      const badProxy = createProxyServer({
        config: { current: { ...BASE_CONFIG, retries: 1, timeout: 1000 } },
        health,
        getProxies: () => [proxyFromUrl(badUrl)],
      });
      const badPort = await listen(badProxy);

      try {
        await httpGetThroughProxy(badPort, TARGET_HOST, targetPort, '/');
      } catch {
        // Expected: the request may throw (transport error) or resolve with a 502 body
        // (HTTP error) — either way the health entry is updated by the proxy.
      }

      // recordFailure is called synchronously inside tryWithRetry before the
      // error propagates to the request handler, so the health entry is up to
      // date immediately — no need for a delay.
      const entry = health.get(badUrl)!;
      assert.ok(entry.fatalErrors >= 1, 'fatalErrors should be >= 1 after failed request (ECONNREFUSED is fatal)');

      badProxy.close();
    });
  });
});
