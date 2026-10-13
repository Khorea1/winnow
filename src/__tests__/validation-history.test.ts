import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createValidationRun, finishValidationRun, getRecentValidationRuns, initDb } from '../db/index.js';

test('migrates existing validation history and records mode and threads for new runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'winnow-history-'));
  const file = join(dir, 'state.db');
  try {
    const oldDb = new Database(file);
    oldDb.exec(`
      CREATE TABLE validation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER NOT NULL, finished INTEGER,
        total INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, exit_code INTEGER
      );
      INSERT INTO validation_runs (started, finished, total, passed, failed, exit_code)
      VALUES (1000, 1010, 4, 3, 1, 0);
    `);
    oldDb.pragma('user_version = 2');
    oldDb.close();

    const db = initDb(file);
    try {
      const oldRun = db.prepare('SELECT * FROM validation_runs WHERE id = 1').get() as Record<string, unknown>;
      assert.equal(oldRun.passed, 3);
      assert.equal(oldRun.mode, null);
      assert.equal(oldRun.threads, null);
      assert.equal(db.pragma('user_version', { simple: true }), 3);

      const id = createValidationRun(db, 'strict', 12);
      finishValidationRun(db, id, 8, 6, 2, 0);
      const runs = getRecentValidationRuns(db) as { id: number; mode: string | null; threads: number | null; passed: number }[];
      assert.equal(runs[0]?.id, id);
      assert.equal(runs[0]?.mode, 'strict');
      assert.equal(runs[0]?.threads, 12);
      assert.equal(runs[0]?.passed, 6);
      assert.equal(runs[1]?.mode, null);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
