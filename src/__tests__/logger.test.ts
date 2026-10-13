import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createLogger } from '../logger.js';

describe('structured logging credential redaction', () => {
  it('redacts upstream credentials from scalar, nested, array, and message values', () => {
    const lines: string[] = [];
    const write = mock.method(process.stderr, 'write', ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      createLogger('redaction-test').error(
        {
          proxy: 'http://alice:secret@proxy.example:3128',
          error: 'dial socks5://bob:pass123@proxy.example:1080 failed',
          nested: { upstreams: ['http://evelyn:topsecret@backup.example:8080'], attempts: 2 },
        },
        'failed via http://carol:password@proxy.example:80',
      );
    } finally {
      write.mock.restore();
    }

    assert.equal(lines.length, 1);
    const line = lines[0];
    for (const secret of ['alice', 'secret', 'bob', 'pass123', 'evelyn', 'topsecret', 'carol', 'password']) {
      assert.ok(!line.includes(secret), `${secret} leaked into logs`);
    }
    const value = JSON.parse(line);
    assert.equal(value.proxy, 'http://***:***@proxy.example:3128');
    assert.equal(value.error, 'dial socks5://***:***@proxy.example:1080 failed');
    assert.deepEqual(value.nested, { upstreams: ['http://***:***@backup.example:8080'], attempts: 2 });
    assert.equal(value.msg, 'failed via http://***:***@proxy.example:80');
    assert.equal(value.name, 'redaction-test');
    assert.equal(value.level, 'ERROR');
  });
});
