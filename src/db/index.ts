import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';

const SCHEMA = `
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

  // Create tables (new databases only — IF NOT EXISTS means existing ones are untouched)
  db.exec(SCHEMA);

  // Migration: add frozen_until to proxy_health (v4.0.0)
  const columnExists = db.prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('proxy_health') WHERE name='frozen_until'").get() as { cnt: number };
  if (columnExists.cnt === 0) {
    db.exec('ALTER TABLE proxy_health ADD COLUMN frozen_until INTEGER NOT NULL DEFAULT 0');
  }
  db.pragma('journal_mode = WAL');
  return db;
}
interface StmtCache {
  upsertHealth: Statement<unknown[]>;
  deleteHealth: Statement<[string]>;
  loadAll: Statement<unknown[], HealthRow>;
  insertRun: Statement<[number]>;
  finishRun: Statement<[number, number, number, number, number, number]>;
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
  const tx = db.transaction((rows: HealthRowInput[]) => {
    const { upsertHealth } = getStmts(db);
    for (const r of rows) upsertHealth.run(r);
  });
  tx(rows);
}

export function loadHealth(db: DatabaseType): HealthRow[] {
  return getStmts(db).loadAll.all();
}

export function removeProxyHealth(db: DatabaseType, proxy: string) {
  getStmts(db).deleteHealth.run(proxy);
}

export function createValidationRun(db: DatabaseType) {
  return getStmts(db).insertRun.run(Date.now()).lastInsertRowid as number;
}

export function finishValidationRun(db: DatabaseType, id: number, total: number, passed: number, failed: number, exitCode: number) {
  getStmts(db).finishRun.run(Date.now(), total, passed, failed, exitCode, id);
}
