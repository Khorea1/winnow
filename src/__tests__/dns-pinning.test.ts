import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { describe, it } from 'node:test';
import { DEFAULTS } from '../config/index.js';
import type { HealthStore } from '../health/index.js';
import { dial, type ParsedProxy } from '../proxy/dial.js';
import { tryWithRetry } from '../proxy/rotator.js';

const PUBLIC_IP = '198.51.100.42';
const TARGET = 'rebind.example';

async function serve(handler: (sock: net.Socket) => void): Promise<{ server: net.Server; proxy: ParsedProxy }> {
  const server = net.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const raw = `http://127.0.0.1:${port}`;
  return { server, proxy: { raw, url: new URL(raw), proto: 'http' } };
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('IP pinning across upstream protocols', () => {
  it('sends a resolved numeric address in HTTP CONNECT, without re-resolving at the upstream', async (t) => {
    let seen = '';
    const { server, proxy } = await serve((sock) => {
      sock.once('data', (data) => {
        seen = data.toString();
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    try {
      let lookups = 0;
      t.mock.method(dns.promises, 'lookup', async () => {
        lookups++;
        return [{ address: PUBLIC_IP, family: 4 }];
      });
      const { sock } = await dial(proxy, TARGET, 443, 2000);
      sock.destroy();
      assert.match(seen, /^CONNECT 198\.51\.100\.42:443 HTTP\/1\.1\r\n/);
      assert.doesNotMatch(seen, /rebind\.example/);
      assert.equal(lookups, 1);
    } finally {
      await close(server);
    }
  });

  it('formats bracketed IPv6 addresses in HTTP CONNECT', async () => {
    let seen = '';
    const { server, proxy } = await serve((sock) => {
      sock.once('data', (data) => {
        seen = data.toString();
        sock.end('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    try {
      const { sock } = await dial(proxy, '2001:4860:4860::8888', 443, 2000);
      sock.destroy();
      assert.match(seen, /^CONNECT \[2001:4860:4860::8888\]:443 HTTP\/1\.1\r\n/);
    } finally {
      await close(server);
    }
  });

  it('sends IP bytes (not a domain name) in SOCKS5 requests', async (t) => {
    let connectRequest: Buffer | undefined;
    const { server, proxy } = await serve((sock) => {
      let phase = 0;
      sock.on('data', (data) => {
        if (phase++ === 0) {
          assert.deepEqual(data, Buffer.from([5, 1, 0]));
          sock.write(Buffer.from([5, 0]));
        } else {
          connectRequest = Buffer.isBuffer(data) ? data : Buffer.from(data);
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
      });
    });
    try {
      const socks = { ...proxy, proto: 'socks5' };
      t.mock.method(dns.promises, 'lookup', async () => [{ address: PUBLIC_IP, family: 4 }]);
      const { sock } = await dial(socks, TARGET, 443, 2000);
      sock.destroy();
      assert.deepEqual(connectRequest, Buffer.from([5, 1, 0, 1, 198, 51, 100, 42, 1, 187]));
    } finally {
      await close(server);
    }
  });

  it('preserves one DNS snapshot across failed and successful retries', async (t) => {
    let attempted = 0;
    let failures = 0;
    let observed = '';
    const bad = await serve((sock) => {
      sock.once('data', () => {
        attempted++;
        sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    });
    const good = await serve((sock) => {
      sock.once('data', (data) => {
        observed = data.toString();
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    });
    const health = {
      isAlive: () => true,
      scoreProxy: (raw: string) => (raw === bad.proxy.raw ? 0 : 100),
      recordFailure: () => {
        failures++;
      },
    } as unknown as HealthStore;
    try {
      let lookups = 0;
      t.mock.method(dns.promises, 'lookup', async () => {
        lookups++;
        return [{ address: lookups === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }];
      });
      t.mock.method(Math, 'random', () => 0.9999);
      const result = await tryWithRetry([bad.proxy, good.proxy], health, { ...DEFAULTS, retries: 2, preConnectJitterMs: 0, sessionAffinityMs: 0 }, TARGET, 443);
      result.sock.destroy();
      assert.equal(result.targetAddress, PUBLIC_IP);
      assert.equal(result.upstream.raw, good.proxy.raw);
      assert.equal(lookups, 1);
      assert.equal(attempted, 1);
      assert.equal(failures, 1);
      assert.match(observed, /^CONNECT 198\.51\.100\.42:443/);
    } finally {
      await Promise.all([close(bad.server), close(good.server)]);
    }
  });

  it('rejects DNS failures before touching health or upstream sockets', async (t) => {
    let selected = 0;
    let failures = 0;
    let connections = 0;
    const { server, proxy } = await serve((sock) => {
      connections++;
      sock.destroy();
    });
    const health = {
      isAlive: () => {
        selected++;
        return true;
      },
      recordFailure: () => {
        failures++;
      },
    } as unknown as HealthStore;
    try {
      t.mock.method(dns.promises, 'lookup', async () => {
        throw new Error('ENOTFOUND');
      });
      await assert.rejects(tryWithRetry([proxy], health, DEFAULTS, TARGET, 443), /target DNS resolution failed/);
      assert.equal(selected, 0);
      assert.equal(failures, 0);
      assert.equal(connections, 0);
    } finally {
      await close(server);
    }
  });
});
