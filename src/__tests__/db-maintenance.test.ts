import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { initDb, startIncrementalVacuum } from '../db/index.js';

const databases: DatabaseType[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function openDb(): DatabaseType {
  const db = initDb(':memory:');
  databases.push(db);
  return db;
}

describe('SQLite maintenance', () => {
  it('uses DELETE fallback when WAL throws, and still creates the schema', () => {
    const prototype = Database.prototype as unknown as { pragma: DatabaseType['pragma'] };
    const original = prototype.pragma;
    let walAttempted = false;
    let fallbackAttempted = false;
    prototype.pragma = function (this: DatabaseType, ...args: Parameters<DatabaseType['pragma']>) {
      if (args[0] === 'journal_mode = WAL') {
        walAttempted = true;
        throw new Error('WAL unavailable');
      }
      if (args[0] === 'journal_mode = DELETE') fallbackAttempted = true;
      return original.apply(this, args);
    };
    try {
      const db = openDb();
      assert.equal(db.pragma('user_version', { simple: true }), 3);
    } finally {
      prototype.pragma = original;
    }
    assert.equal(walAttempted, true);
    assert.equal(fallbackAttempted, true);
  });

  it('uses DELETE fallback when WAL silently remains disabled', () => {
    const prototype = Database.prototype as unknown as { pragma: DatabaseType['pragma'] };
    const original = prototype.pragma;
    let fallbackAttempted = false;
    prototype.pragma = function (this: DatabaseType, ...args: Parameters<DatabaseType['pragma']>) {
      if (args[0] === 'journal_mode = WAL') return 'delete';
      if (args[0] === 'journal_mode = DELETE') fallbackAttempted = true;
      return original.apply(this, args);
    };
    try {
      openDb();
    } finally {
      prototype.pragma = original;
    }
    assert.equal(fallbackAttempted, true);
  });

  it('periodically reclaims unused pages and stops cleanly', async () => {
    const db = openDb();
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
    db.exec('CREATE TABLE payload (value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO payload VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) insert.run('x'.repeat(1000));
    })();
    db.exec('DELETE FROM payload');
    const pagesBefore = db.pragma('page_count', { simple: true }) as number;
    assert.ok((db.pragma('freelist_count', { simple: true }) as number) > 0);
    const stop = startIncrementalVacuum(db, 10);
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && (db.pragma('page_count', { simple: true }) as number) >= pagesBefore) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.ok((db.pragma('page_count', { simple: true }) as number) < pagesBefore);
    } finally {
      stop();
      stop();
    }
  });

  it('rejects invalid maintenance intervals', () => {
    const db = openDb();
    assert.throws(() => startIncrementalVacuum(db, 0), RangeError);
    assert.throws(() => startIncrementalVacuum(db, Number.NaN), RangeError);
  });
});
