import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventLog } from '../events.js';

describe('EventLog', () => {
  it('starts empty', () => {
    const log = new EventLog(100);
    assert.equal(log.all.length, 0);
    assert.equal(log.recent().length, 0);
  });

  it('push returns event with id and ts', () => {
    const log = new EventLog(100);
    const e = log.push({ type: 'connect', proxy: '1.2.3.4:80', target: 'example.com:80', status: 'attempt' });
    assert.equal(e.id, 1);
    assert.equal(typeof e.ts, 'number');
    assert.ok(e.ts > 0);
    assert.equal(e.type, 'connect');
    assert.equal(e.status, 'attempt');
  });

  it('push increments id', () => {
    const log = new EventLog(100);
    assert.equal(log.push({ type: 'connect', proxy: 'p1', target: 't1', status: 'attempt' }).id, 1);
    assert.equal(log.push({ type: 'connect', proxy: 'p2', target: 't1', status: 'success' }).id, 2);
    assert.equal(log.push({ type: 'ban', proxy: 'p3', target: 't2', status: 'info' }).id, 3);
  });

  it('recent returns last N events', () => {
    const log = new EventLog(100);
    for (let i = 0; i < 10; i++) {
      log.push({ type: 'connect', proxy: `p${i}`, target: 't', status: 'attempt' });
    }
    assert.equal(log.recent(3).length, 3);
    assert.equal(log.recent(3)[0].proxy, 'p7');
    assert.equal(log.recent(3)[2].proxy, 'p9');
  });

  it('recent returns all when limit >= size', () => {
    const log = new EventLog(100);
    for (let i = 0; i < 5; i++) {
      log.push({ type: 'connect', proxy: `p${i}`, target: 't', status: 'attempt' });
    }
    assert.equal(log.recent(10).length, 5);
    assert.equal(log.recent().length, 5);
  });

  it('trims to maxSize', () => {
    const log = new EventLog(5);
    for (let i = 0; i < 10; i++) {
      log.push({ type: 'connect', proxy: `p${i}`, target: 't', status: 'attempt' });
    }
    assert.equal(log.all.length, 5);
    assert.equal(log.all[0].proxy, 'p5');
  });

  it('clear empties the log', () => {
    const log = new EventLog(100);
    log.push({ type: 'connect', proxy: 'p1', target: 't', status: 'attempt' });
    log.clear();
    assert.equal(log.all.length, 0);
  });

  it('subscribe receives events', () => {
    const log = new EventLog(100);
    const received: any[] = [];
    log.subscribe((e) => received.push(e));
    log.push({ type: 'connect', proxy: 'p1', target: 't', status: 'success', latency: 100 });
    assert.equal(received.length, 1);
    assert.equal(received[0].proxy, 'p1');
    assert.equal(received[0].latency, 100);
  });

  it('subscribe does not receive events after unsubscribe', () => {
    const log = new EventLog(100);
    const received: any[] = [];
    const fn = (e: any) => received.push(e);
    log.subscribe(fn);
    log.push({ type: 'connect', proxy: 'p1', target: 't', status: 'attempt' });
    log.unsubscribe(fn);
    log.push({ type: 'connect', proxy: 'p2', target: 't', status: 'attempt' });
    assert.equal(received.length, 1);
  });

  it('listener exceptions do not crash push', () => {
    const log = new EventLog(100);
    log.subscribe(() => {
      throw new Error('boom');
    });
    assert.doesNotThrow(() => {
      log.push({ type: 'connect', proxy: 'p1', target: 't', status: 'attempt' });
    });
  });

  it('static safePush does nothing when el is undefined', () => {
    assert.doesNotThrow(() => EventLog.safePush(undefined, { type: 'connect', proxy: 'p', target: 't', status: 'attempt' }));
  });

  it('static safePush pushes when el is defined', () => {
    const log = new EventLog(100);
    EventLog.safePush(log, { type: 'connect', proxy: 'p1', target: 't', status: 'attempt' });
    assert.equal(log.all.length, 1);
  });

  it('static safePush does not crash on listener error', () => {
    const log = new EventLog(100);
    log.subscribe(() => {
      throw new Error('boom');
    });
    assert.doesNotThrow(() => EventLog.safePush(log, { type: 'connect', proxy: 'p', target: 't', status: 'attempt' }));
  });

  it('handles all event types', () => {
    const log = new EventLog(100);
    const types = ['connect', 'http', 'healthcheck', 'retry', 'ban', 'unban', 'freeze', 'classify', 'pool'] as const;
    for (const type of types) {
      const e = log.push({ type, proxy: 'p1', target: 't', status: 'info' });
      assert.equal(e.type, type);
    }
    assert.equal(log.all.length, types.length);
  });

  it('handles optional detail fields', () => {
    const log = new EventLog(100);
    const e = log.push({
      type: 'classify',
      proxy: 'p1',
      target: 't',
      status: 'failure',
      error: 'ECONNREFUSED',
      errorCode: 'ECONNREFUSED',
      errorClass: 'fatal',
      latency: 500,
      bytes: 1024,
      detail: 'connection refused',
    });
    assert.equal(e.error, 'ECONNREFUSED');
    assert.equal(e.errorCode, 'ECONNREFUSED');
    assert.equal(e.errorClass, 'fatal');
    assert.equal(e.latency, 500);
    assert.equal(e.bytes, 1024);
    assert.equal(e.detail, 'connection refused');
  });
});
