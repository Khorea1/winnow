import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChunkedBodyDecoder, MAX_RESPONSE_HEADER_BYTES, parseResponseHeaders, STRIPPED_REQUEST_HEADERS } from '../proxy/responseParser.js';

describe('parseResponseHeaders', () => {
  it('parses a simple 200 response with body', () => {
    const buf = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nbody');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.statusCode, 200);
    assert.equal(res!.headers['Content-Type'], 'text/html');
    assert.deepEqual(res!.body, Buffer.from('body'));
  });

  it('parses a 404 status code', () => {
    const buf = Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nnot here');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.statusCode, 404);
    assert.equal(res!.headers['Content-Type'], 'text/plain');
  });

  it('returns null for incomplete headers (no \\r\\n\\r\\n terminator)', () => {
    const buf = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/html');
    const res = parseResponseHeaders(buf);
    assert.equal(res, null);
  });

  it('handles split headers across two chunks', () => {
    const first = Buffer.from('HTTP/1.1 200 OK\r\nContent-');
    const partial = parseResponseHeaders(first);
    assert.equal(partial, null);

    const combined = Buffer.concat([first, Buffer.from('Type: text/html\r\n\r\nbody')]);
    const res = parseResponseHeaders(combined);
    assert.ok(res);
    assert.equal(res!.statusCode, 200);
    assert.equal(res!.headers['Content-Type'], 'text/html');
    assert.deepEqual(res!.body, Buffer.from('body'));
  });

  it('skips 100-continue interim and parses final response', () => {
    const buf = Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.statusCode, 200);
    assert.equal(res!.headers['Content-Type'], 'text/plain');
    assert.deepEqual(res!.body, Buffer.from('hello'));
  });

  it('returns null for 100-continue with only interim (no final yet)', () => {
    const buf = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');
    const res = parseResponseHeaders(buf);
    assert.equal(res, null);
  });

  it('throws on oversized header buffer without terminator', () => {
    const oversized = Buffer.alloc(MAX_RESPONSE_HEADER_BYTES + 1, 0x41); // 'A' repeated, no \r\n\r\n
    assert.throws(() => parseResponseHeaders(oversized), /too large/i);
  });

  it('strips hop-by-hop headers from output', () => {
    const buf = Buffer.from(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\nbody',
    );
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.headers['connection'], undefined);
    assert.equal(res!.headers['keep-alive'], undefined);
    assert.equal(res!.headers['Connection'], undefined);
    assert.equal(res!.headers['Keep-Alive'], undefined);
    assert.equal(res!.headers['Transfer-Encoding'], undefined);
    assert.equal(STRIPPED_REQUEST_HEADERS['transfer-encoding'], true);
    assert.equal(res!.isChunked, true);
    assert.equal(res!.headers['Content-Length'], undefined);
  });

  it('decodes chunked bodies when framing is split across chunks', () => {
    const chunks: Buffer[] = [];
    const decoder = createChunkedBodyDecoder((chunk) => chunks.push(Buffer.from(chunk)));
    const wire = Buffer.from('4\r\nWiki\r\n5;ext=x\r\npedia\r\n0\r\nX-Trailer: ignored\r\n\r\n');

    for (const byte of wire) {
      assert.equal(decoder.write(Buffer.from([byte])), true);
    }

    assert.equal(decoder.end(), true);
    assert.equal(Buffer.concat(chunks).toString(), 'Wikipedia');
  });

  it('rejects malformed or incomplete chunked bodies', () => {
    const malformed = createChunkedBodyDecoder(() => {});
    assert.equal(malformed.write(Buffer.from('Z\r\n')), false);

    const truncated = createChunkedBodyDecoder(() => {});
    assert.equal(truncated.write(Buffer.from('4\r\nabc')), true);
    assert.equal(truncated.end(), false);
  });

  it('strips headers named in the Connection header value', () => {
    const buf = Buffer.from('HTTP/1.1 200 OK\r\nConnection: X-Custom-Header\r\nX-Custom-Header: value\r\n\r\nbody');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.headers['X-Custom-Header'], undefined);
    assert.equal(res!.headers['x-custom-header'], undefined);
  });

  it('combines duplicate headers into an array', () => {
    const buf = Buffer.from('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.deepEqual(res!.headers['Set-Cookie'], ['a=1', 'b=2']);
  });

  it('handles empty body for 204 response', () => {
    const buf = Buffer.from('HTTP/1.1 204 No Content\r\n\r\n');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.statusCode, 204);
    assert.deepEqual(res!.body, Buffer.alloc(0));
    assert.equal(Object.keys(res!.headers).length, 0);
  });

  it('handles response with no headers (just status line)', () => {
    const buf = Buffer.from('HTTP/1.1 200 OK\r\n\r\nbody');
    const res = parseResponseHeaders(buf);
    assert.ok(res);
    assert.equal(res!.statusCode, 200);
    assert.equal(Object.keys(res!.headers).length, 0);
    assert.deepEqual(res!.body, Buffer.from('body'));
  });
});
