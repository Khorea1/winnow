import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { initDb, startIncrementalVacuum } from '../db/index.js';

const openDatabases: DatabaseType[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
});

function openDb() {
  const db = initDb(':memory:');
  openDatabases.push(db);
  return db;
}

describe('database maintenance', () => {
  it('falls back to DELETE journal mode when enabling WAL throws', () => {
    const prototype = Database.prototype as unknown as {
      pragma: DatabaseType['pragma'];
    };
    const originalPragma = prototype.pragma;
    let walAttempted = false;
    let deleteFallbackAttempted = false;
    prototype.pragma = function (this: DatabaseType, ...args: Parameters<DatabaseType['pragma']>) {
      if (args[0] === 'journal_mode = WAL') {
        walAttempted = true;
        throw new Error('WAL unavailable');
      }
      if (args[0] === 'journal_mode = DELETE') deleteFallbackAttempted = true;
      return originalPragma.apply(this, args);
    };

    let db: DatabaseType;
    try {
      db = openDb();
    } finally {
      prototype.pragma = originalPragma;
    }

    assert.equal(walAttempted, true);
    assert.equal(deleteFallbackAttempted, true);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'memory');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'proxy_health'").get() as { count: number }).count,
      1,
    );
  });

  it('reclaims free pages periodically and can be stopped', async () => {
    const db = openDb();
    db.exec('CREATE TABLE maintenance_payload (value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO maintenance_payload (value) VALUES (?)');
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run('x'.repeat(4000));
    });
    insertMany();
    db.exec('DELETE FROM maintenance_payload');

    const before = db.pragma('page_count', { simple: true }) as number;
    const stop = startIncrementalVacuum(db, 10);
    try {
      const deadline = Date.now() + 3000;
      // Exercise the real periodic timer; SQLite page reclamation is the observable signal.
      while ((db.pragma('page_count', { simple: true }) as number) >= before && Date.now() < deadline) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 10);
        await promise;
      }
      assert.ok((db.pragma('page_count', { simple: true }) as number) < before);
    } finally {
      stop();
      stop();
    }
  });
});
