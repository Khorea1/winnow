import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { atomicRewrite } from '../atomicRewrite.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createTarget(initial: string): Promise<{ directory: string; target: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'winnow-atomic-rewrite-'));
  directories.push(directory);
  const target = path.join(directory, 'state.txt');
  await fs.writeFile(target, initial, 'utf8');
  return { directory, target };
}

describe('atomicRewrite', () => {
  it('serializes concurrent append transforms without losing updates', async () => {
    const { target } = await createTarget('');
    const appends = Array.from({ length: 40 }, (_, index) => atomicRewrite(target, (content) => `${content}${index}\n`));

    await Promise.all(appends);

    const lines = (await fs.readFile(target, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, appends.length);
    assert.deepEqual(new Set(lines), new Set(appends.map((_, index) => `${index}`)));
  });

  it('leaves original bytes unchanged when the transform returns null', async () => {
    const { directory, target } = await createTarget('saved café\n');
    const original = await fs.readFile(target);

    assert.equal(await atomicRewrite(target, () => null), null);

    assert.deepEqual(await fs.readFile(target), original);
    assert.deepEqual(await fs.readdir(directory), ['state.txt']);
  });

  it('leaves the original file unchanged when the transform throws', async () => {
    const { directory, target } = await createTarget('before\n');
    const original = await fs.readFile(target);

    await assert.rejects(
      atomicRewrite(target, () => {
        throw new Error('transform failed');
      }),
      /transform failed/,
    );

    assert.deepEqual(await fs.readFile(target), original);
    assert.deepEqual(await fs.readdir(directory), ['state.txt']);
  });

  it('atomically replaces the file and leaves no temporary file', async () => {
    const { directory, target } = await createTarget('before\n');
    const originalInode = (await fs.stat(target)).ino;

    assert.equal(await atomicRewrite(target, (content) => `${content}after\n`), 'before\nafter\n');

    assert.equal(await fs.readFile(target, 'utf8'), 'before\nafter\n');
    assert.notEqual((await fs.stat(target)).ino, originalInode);
    assert.deepEqual(await fs.readdir(directory), ['state.txt']);
  });

  it('creates a missing output file with restrictive permissions', async () => {
    const { directory } = await createTarget('');
    const target = path.join(directory, 'new.txt');

    assert.equal(await atomicRewrite(target, (content) => `${content}proxy\n`), 'proxy\n');

    assert.equal(await fs.readFile(target, 'utf8'), 'proxy\n');
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['new.txt', 'state.txt']);
  });
});
