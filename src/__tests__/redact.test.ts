import assert from 'node:assert/strict';
import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { publicProxyKey, redactProxyText } from '../proxy/redact.js';
import { buildOptionsFromConfig } from '../validator/index.js';
import { runValidation } from '../validator/runner.js';
import type { ProxyResult } from '../validator/types.js';

describe('publicProxyKey', () => {
  it('normalizes URLs and protocol-less proxy keys without exposing userinfo', () => {
    for (const proxy of [
      'http://alice:s3cret@proxy.example:3128',
      'alice:s3cret@proxy.example:3128',
      'socks5://alice:s3cret@proxy.example:3128',
      'http://alice%40domain:s3%40cret@proxy.example:3128',
    ]) {
      assert.equal(publicProxyKey(proxy), 'proxy.example:3128');
    }
  });

  it('handles IPv6 addresses and URL query strings', () => {
    assert.equal(publicProxyKey('http://alice:secret@[2001:db8::1]:3128/private?token=secret'), '[2001:db8::1]:3128');
    assert.equal(publicProxyKey('[2001:db8::1]:3128'), '[2001:db8::1]:3128');
  });

  it('preserves plain proxy keys and pool events', () => {
    assert.equal(publicProxyKey('proxy.example:3128'), 'proxy.example:3128');
    assert.equal(publicProxyKey('(all)'), '(all)');
    assert.equal(publicProxyKey(''), '');
  });

  it('fails closed for malformed URLs that may contain credentials', () => {
    assert.equal(publicProxyKey('http://alice:secret@['), '[invalid proxy]');
  });
});

describe('redactProxyText', () => {
  it('scrubs credential-bearing proxy URLs in diagnostic strings', () => {
    assert.equal(redactProxyText('Cannot dial socks5://alice:secret@proxy.example:1080: timeout'), 'Cannot dial proxy.example:1080: timeout');
    assert.equal(redactProxyText('failed on alice:secret@host:3128'), 'failed on host:3128');
    assert.equal(redactProxyText('failed on socks5://alice@proxy.example:1080'), 'failed on proxy.example:1080');
    assert.equal(redactProxyText('failed on alice@proxy.example:1080'), 'failed on proxy.example:1080');
    assert.equal(redactProxyText('failed on socks5://alice:p@ss@proxy.example:1080'), 'failed on proxy.example:1080');
  });

  it('does not alter other diagnostic messages', () => {
    assert.equal(redactProxyText('HTTP 503 - timed out'), 'HTTP 503 - timed out');
    assert.equal(redactProxyText('mail alice@example.com'), 'mail alice@example.com');
  });
});

it('keeps raw proxy keys in validation callbacks but redacts returned display results', async () => {
  const server = net.createServer((socket) => socket.destroy());
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const raw = `http://alice:secret@127.0.0.1:${(server.address() as AddressInfo).port}`;
    const progress: ProxyResult[] = [];
    const opts = buildOptionsFromConfig({}, { mode: 'tcp-only', threads: 1, throttle: 0, strictTLS: false });
    const result = await runValidation([raw], opts, (entry) => progress.push(entry));

    assert.deepEqual(result.valid, [raw]);
    assert.equal(progress[0]?.proxy, raw);
    assert.equal(result.results[0]?.proxy, publicProxyKey(raw));
    assert.ok(!JSON.stringify(result.results).includes('secret'));
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
