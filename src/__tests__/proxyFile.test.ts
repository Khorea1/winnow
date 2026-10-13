import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { atomicRewrite } from '../atomicRewrite.js';
import { appendUniqueProxies, pruneValidatedLines, replaceValidatedProxies } from '../proxy/proxyFile.js';

describe('proxy file transforms', () => {
  it('prunes only checked invalid entries while preserving comments, blanks and concurrent additions', () => {
    const content = '# pool\nhttp://valid:80\n\n  # keep\nhttp://invalid:80\nhttp://added-later:80\n';
    const next = pruneValidatedLines(content, new Set(['http://valid:80', 'http://invalid:80']), new Set(['http://valid:80']));
    assert.equal(next, '# pool\nhttp://valid:80\n\n  # keep\nhttp://added-later:80\n');
    assert.equal(pruneValidatedLines(next!, new Set(['http://valid:80']), new Set(['http://valid:80'])), null);
  });

  it('appends distinct proxies once and leaves unrelated text unchanged', () => {
    const updated = appendUniqueProxies('# initial\nhttp://first:80\n', ['http://first:80', 'http://second:80', 'http://second:80']);
    assert.deepEqual(updated, { content: '# initial\nhttp://first:80\nhttp://second:80\n', added: 1 });
    assert.deepEqual(appendUniqueProxies(updated.content!, ['http://second:80']), { content: null, added: 0 });
    assert.deepEqual(appendUniqueProxies('# annotation\n\n', ['http://third:80']), {
      content: '# annotation\n\nhttp://third:80\n',
      added: 1,
    });
  });

  it('replaces CLI output but preserves comments and intentional blank lines', () => {
    assert.equal(replaceValidatedProxies('', ['http://good:80']), 'http://good:80\n');
    assert.equal(replaceValidatedProxies('http://old:80\n', ['http://new:80']), 'http://new:80\n');
    assert.equal(replaceValidatedProxies('# keep\n\nhttp://old:80\n', ['http://new:80']), '# keep\n\nhttp://new:80\n');
  });

  it('serializes interleaved appends and pruning with the latest file contents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'winnow-proxyfile-'));
    const file = path.join(dir, 'proxies.txt');
    try {
      await fs.writeFile(file, '# pool\nhttp://invalid:80\n', 'utf8');
      await Promise.all([
        atomicRewrite(file, (content) => appendUniqueProxies(content, ['http://added-a:80']).content),
        atomicRewrite(file, (content) => pruneValidatedLines(content, new Set(['http://invalid:80']), new Set())),
        atomicRewrite(file, (content) => appendUniqueProxies(content, ['http://added-b:80']).content),
      ]);
      assert.equal(await fs.readFile(file, 'utf8'), '# pool\nhttp://added-a:80\nhttp://added-b:80\n');
      assert.deepEqual(await fs.readdir(dir), ['proxies.txt']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
