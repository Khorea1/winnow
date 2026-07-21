import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';

const SCHEMA = `
-- Note: all timestamp columns (started, finished, banned_until, last_ok, frozen_until)
-- store Unix epoch time in SECONDS (not milliseconds) for SQLite datetime function compatibility.
CREATE TABLE IF NOT EXISTS proxy_health (
  proxy  TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '*',
  errors INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  latency INTEGER NOT NULL DEFAULT 9999,
  banned_until INTEGER NOT NULL DEFAULT 0,
  last_ok INTEGER NOT NULL DEFAULT 0,
  fatal_errors INTEGER NOT NULL DEFAULT 0,
  frozen_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (proxy, target)
);
CREATE TABLE IF NOT EXISTS validation_runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  started   INTEGER NOT NULL,
  finished  INTEGER,
  total     INTEGER NOT NULL DEFAULT 0,
  passed    INTEGER NOT NULL DEFAULT 0,
  failed    INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER
);
`;

export type HealthRow = {
  proxy: string;
  target: string;
  errors: number;
  successes: number;
  latency: number;
  banned_until: number;
  last_ok: number;
  fatal_errors: number;
  frozen_until: number;
};

export function initDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('wal_autocheckpoint = 500');

  // Schema versioning
  const userVersion = db.pragma('user_version', { simple: true }) as number;
  if (userVersion < 1) {
    db.exec(SCHEMA);
    db.pragma('user_version = 1');
  } else {
    db.exec(SCHEMA); // still run CREATE TABLE IF NOT EXISTS for safety
  }
  // Version 2: add frozen_until
  if ((db.pragma('user_version', { simple: true }) as number) < 2) {
    const columnExists = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('proxy_health') WHERE name='frozen_until'").get() as { cnt: number };
    if (columnExists.cnt === 0) {
      db.exec('ALTER TABLE proxy_health ADD COLUMN frozen_until INTEGER NOT NULL DEFAULT 0');
    }
    db.pragma('user_version = 2');
  }

  return db;
}
interface StmtCache {
  upsertHealth: Statement<unknown[]>;
  deleteHealth: Statement<[string]>;
  loadAll: Statement<unknown[], HealthRow>;
  insertRun: Statement<[number]>;
  finishRun: Statement<[number, number, number, number, number, number]>;
  upsertTx: (rows: HealthRowInput[]) => void;
}
const stmtCache = new WeakMap<DatabaseType, StmtCache>();
function getStmts(db: DatabaseType): StmtCache {
  let s = stmtCache.get(db);
  if (!s) {
    s = {
      upsertHealth: db.prepare(`
        INSERT INTO proxy_health (proxy, target, errors, successes, latency, banned_until, last_ok, fatal_errors, frozen_until)
        VALUES (@proxy, @target, @errors, @successes, @latency, @bannedUntil, @lastOk, @fatalErrors, @frozenUntil)
        ON CONFLICT(proxy, target) DO UPDATE SET
          errors = excluded.errors,
          successes = excluded.successes,
          latency = excluded.latency,
          banned_until = excluded.banned_until,
          last_ok = excluded.last_ok,
          fatal_errors = excluded.fatal_errors,
          frozen_until = excluded.frozen_until
      `),
      deleteHealth: db.prepare('DELETE FROM proxy_health WHERE proxy = ?'),
      loadAll: db.prepare('SELECT * FROM proxy_health'),
      insertRun: db.prepare('INSERT INTO validation_runs (started) VALUES (?)'),
      finishRun: db.prepare('UPDATE validation_runs SET finished = ?, total = ?, passed = ?, failed = ?, exit_code = ? WHERE id = ?'),
      upsertTx: db.transaction((rows: HealthRowInput[]) => {
        for (const r of rows) s!.upsertHealth.run(r);
      }),
    };
    stmtCache.set(db, s);
  }
  return s;
}

export interface HealthRowInput {
  proxy: string;
  target: string;
  errors: number;
  successes: number;
  latency: number;
  bannedUntil: number;
  lastOk: number;
  fatalErrors: number;
  frozenUntil: number;
}

export function insertHealth(db: DatabaseType, rows: HealthRowInput[]) {
  getStmts(db).upsertTx(rows);
}

export function loadHealth(db: DatabaseType): HealthRow[] {
  return getStmts(db).loadAll.all();
}

export function removeProxyHealth(db: DatabaseType, proxy: string) {
  const result = getStmts(db).deleteHealth.run(proxy);
  if (result.changes === 0) {
    // Proxy may already have been removed — non-critical
  }
}

export function createValidationRun(db: DatabaseType) {
  return getStmts(db).insertRun.run(Math.floor(Date.now() / 1000)).lastInsertRowid as number;
}

export function finishValidationRun(db: DatabaseType, id: number, total: number, passed: number, failed: number, exitCode: number) {
  const result = getStmts(db).finishRun.run(Math.floor(Date.now() / 1000), total, passed, failed, exitCode, id);
  if (result.changes === 0) {
    // Validation run id not found — may indicate stale state
  }
}
