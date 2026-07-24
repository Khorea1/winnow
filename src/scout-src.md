# Scout-Src: Winnow & Depengine Pattern Analysis

## Winnow (TypeScript Proxy Rotator) — Primary Target

### Error Handling Pattern
- **Thrown errors + try/catch** — no Result/Option types, no discriminated unions for success/failure
- Errors are thrown and caught with `try { ... } catch (e: unknown) { ... }`
- Standard pattern for extracting error info:
  ```
  const msg = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === 'object' && 'code' in e ? String((e as Record<string, unknown>).code) : undefined;
  ```
- **Fatal vs Transient classification**: `classifyError(e)` returns `'fatal' | 'transient'` based on:
  - `FATAL_ERR_CODES` set (ECONNREFUSED, CERT_*, TLS errors, EPROTO, etc.)
  - `FATAL_MSG_REGEX` fallback for errors without codes (TLS, SSL, certificate, handshake, SOCKS patterns)
  - SOCKSv5 reply-code matching against `SOCKS_FATAL_REPLIES`
  - Default: `'transient'` (assume recoverable)
- **Fail-safe event logging**: `EventLog.safePush(el, event)` wraps push in try/catch, never crashes
- **Listener isolation**: subscriber callbacks run in `queueMicrotask` with per-listener try/catch
- **Graceful shutdown**: `SIGTERM`/`SIGINT` handlers with 10s force-exit timeout
- **Uncaught exception/rejection handlers** that flush health store and exit
- **Health scoring**: `applyFailure(h, e, config, now, preclassified?)` updates in-memory state with ban/freeze logic; `applySuccess(h, latency, now)` updates EMA latency
- No `Result<T, E>` pattern, no Either/Option types

### Module/Exports Pattern
- **Named exports only** — zero default exports across the codebase
- Barrel files via `export { ... } from './foo.js'` (e.g., health/index.ts re-exports from classify.ts)
- Type-only re-exports: `export { applyFailure, ..., type HealthEntry } from './classify.js'`
- ES module format with explicit `.js` extensions in imports (compiled from .ts)
- `import type` for type-only imports
- Interfaces for public contracts, `type` aliases for unions/simple objects/function signatures
- No namespaced exports or `export =`

### Async Pattern
- **async/await exclusively** — no raw `.then()` chains anywhere
- `new Promise((resolve, reject) => { ... })` for wrapping callback-based APIs (net.Socket, tls.connect, DNS, file system)
- **Done-flag pattern** for race safety in promise constructors:
  ```
  let done = false;
  sock.on('data', (d) => { if (done) return; ... });
  sock.on('close', () => { if (!done) { done = true; ... } });
  setTimeout(() => { if (!done) { done = true; reject(...); } }, timeout);
  ```
- Worker pool with shared queue: `runValidation` creates N workers that pull from a shared index
- `Promise.allSettled` for parallel operations (health checks)
- `AbortSignal` for cancellation (validator runner with `withAbort` helper)
- `queueMicrotask` for deferring non-critical work (event notifications, health store flushes)
- `setInterval` with `.unref()` for background timers (health check polling)
- No async generators/iterators used in src (only in dashboard test files)
- `EventEmitter` used by `HealthStore` (extends EventEmitter) for relay events; no app-level event emitters otherwise

### Config Pattern
- **JSON file** (`config.json` via `loadConfig()`), auto-created with defaults if missing
- Precedence: CLI flags > env vars > config file > compile-time `DEFAULTS`
- CLI flag parser: manual (hand-written `parseArgv` in index.ts, no minimist/yargs)
- Env vars: `WINNOW_CONFIG`, `WINNOW_DATA_DIR`/`DATA_DIR`, `WINNOW_PROXY_FILE`/`PROXY_FILE`, `WINNOW_PORT`/`PORT`, `WINNOW_VALIDATION_MODE`, `LOG_LEVEL`, `WINNOW_TOKEN`/`DASHBOARD_TOKEN`/`API_TOKEN`
- `resolveDataDir()`: WINNOW_DATA_DIR > DATA_DIR > cwd
- `sanitize(cfg)` function validates all fields with:
  - `clampInt(v, min, max, def)` — integer clamping
  - `clampNum(v, min, max, def)` — float clamping
  - `ensureString(v, def, validate?)` — string with optional custom validator
  - `ensureMode(v, def)` — validated enum values
- SSRF validation on config values (URLs, hosts) via `isBlockedTarget()`
- `updateConfig(patch, currentRuntime?)` for hot-reload via API
- `API_ALLOWED_KEYS` controls which fields can be hot-reloaded
- `configRef` object pattern: `{ current: RotatorConfig }` — runtime code reads `configRef.current` for hot-reload awareness
- Config interface exported as `RotatorConfig`

### DI/State Pattern
- **Manual constructor injection**: `new HealthStore(db, config, eventLog)`
- **Factory functions**: `createProxyServer(ctx)`, `createLogger(name)`, `createValidationRun()`
- **No DI container or framework**
- **Mutable shared state**:
  - `concurrentConnections: number` — global counter with MAX_CONCURRENT_CONNECTIONS cap
  - `_hcRunning: boolean` — health check tick guard
  - `_pendingReload: boolean` — coalesced reload flag
  - `_hcTimer` — health check timer handle
- **WeakMap cache** for prepared SQL statements: `stmtCache = new WeakMap<DatabaseType, StmtCache>()`
- **Hot-reload**: config changes propagate through `configRef.current` reference
- **Event subscription pattern**: `eventLog.subscribe(fn)` returns unsubscribe function
- **EventEmitter**: HealthStore extends EventEmitter for `health:update` events
- **SSE broadcasting**: server-sent events push health/event updates to dashboard clients

### Database Pattern (better-sqlite3)
- **Synchronous** SQLite via `better-sqlite3`
- Connection: `new Database(path)` in `initDb()`
- Pragmas: `journal_mode = WAL`, `synchronous = NORMAL`, `auto_vacuum = INCREMENTAL`, `wal_autocheckpoint = 500`
- Schema versioning: `pragma user_version` with incremental migration (v1 → v2 added frozen_until)
- `CREATE TABLE IF NOT EXISTS` always runs for safety
- **WeakMap statement cache**: prepared statements cached per-Database instance
- Named parameters with `@param` syntax
- UPSERT: `INSERT ... ON CONFLICT(proxy, target) DO UPDATE SET ...`
- Batch transactions: `db.transaction((rows) => { for (const r of rows) stmt.run(r); })`
- Tables: `proxy_health(proxy, target, errors, successes, latency, banned_until, last_ok, fatal_errors, frozen_until)` with composite PK, `validation_runs(id, started, finished, total, passed, failed, exit_code)`
- Helper functions: `initDb(path)`, `insertHealth(db, rows)`, `loadHealth(db)`, `removeProxyHealth(db, proxy)`, `createValidationRun(db)`, `finishValidationRun(...)`, `getRecentValidationRuns(db, limit)`
- Timestamp convention: `validation_runs` uses **seconds** (Unix epoch), `proxy_health` uses **milliseconds** (for consistency with in-memory `HealthEntry`)

### Key File Responsibilities
| File | Role |
|---|---|
| `src/index.ts` | Entry point: CLI parsing, config loading, DB init, server startup, graceful shutdown |
| `src/config/index.ts` | Config loading, validation, sanitization, hot-reload API, RotatorConfig interface |
| `src/events.ts` | EventLog ring buffer with subscribe/unsubscribe, SSE events |
| `src/logger.ts` | Structured JSON logger to stderr, LOG_LEVEL env support |
| `src/health/index.ts` | HealthStore (EventEmitter): in-memory per-proxy health state, periodic DB flush, ban/freeze/prune logic |
| `src/health/classify.ts` | Pure functions: classifyError, applyFailure, applySuccess, transientBanMs, blankEntry, HealthEntry interface |
| `src/proxy/dial.ts` | Low-level proxy dialing: httpConnect, socks5Connect, parseLine, parseHostPort |
| `src/proxy/rotator.ts` | Proxy pool: pickMany ranking, tryWithRetry retry loop, healthCheckTick |
| `src/proxy/server.ts` | HTTP proxy server: CONNECT handler, HTTP forward handler, byte counting, timeout management |
| `src/proxy/tls.ts` | tlsHandshake helper, isSoftTlsError classification |
| `src/proxy/ssrf.ts` | SSRF prevention: isBlockedTarget (pre-DNS), isBlockedAfterDns (post-DNS) |
| `src/proxy/timeout.ts` | startSocketTimeout: TTFB + idle timeout for proxied connections |
| `src/db/index.ts` | SQLite schema, statement cache, CRUD helpers |
| `src/dashboard/index.ts` | Dashboard HTTP API: SSE streaming, config hot-reload, validation trigger, proxy management |
| `src/validator/types.ts` | ValidatorOptions, ProxyResult, ProgressCallback interfaces |
| `src/validator/runner.ts` | Validation orchestrator: worker pool, stage pipeline (TCP → HTTP → TLS → stream), per-proxy timeout |
| `src/validator/index.ts` | CLI entry for standalone validation: buildOptionsFromConfig, validateFile, cliMain |
| `src/validator/checks/http.ts` | HTTP GET through proxy, response parsing, anonymity check |
| `src/validator/checks/tcp.ts` | TCP connectivity check via proxy |
| `src/validator/checks/tls.ts` | TLS handshake check through proxy |
| `src/validator/checks/streaming.ts` | Chunked streaming response analysis (TTFB ratio, gap detection) |

---

## Depengine (Go Dependency Engine) — Patterns to Note

### Error Handling
- Standard Go `error` interface with `fmt.Errorf("...: %w", err)` wrapping
- Typed error codes: `type ErrorCode string` with `E_REQUIRED_FIELD = "E_REQUIRED_FIELD"` constants
- Error/warning distinction: `IsError()` checks `E_` prefix
- `errors.As` for type assertions on wrapped errors
- Panic on adapter registration conflict (fail-fast at init)
- Sentinel file-not-found handling with `os.IsNotExist(err)`

### Module Layout
- `pkg/<name>/` subpackages with single responsibility
- Interface-based public API (Adapter, Remover, Runner)
- `init()` functions for self-registration of adapters
- Factory functions: `NewNativeAdapter("")`, `NewCargoAdapter()`

### Concurrency/Async
- Goroutines + channels for parallel execution
- `sync.Mutex` for report aggregation during parallel installs
- `context.Context` for cancellation throughout
- File-level locking: `lock()`/`lockShared()` for state file

### Config
- TOML schema files + JSON state file at XDG path
- Atomic file writes: temp → fsync → rename → directory fsync
- XDG paths: `$XDG_STATE_HOME/depengine/state.json`
- Locale detection: LANGUAGE > LC_ALL > LC_MESSAGES > LANG chain

### DI Pattern
- Global registry pattern: `exec.Register(a Adapter)`, `exec.Lookup(kind string) Adapter`
- Interface injection: `run.Runner` passed to adapters instead of hardcoded os/exec
- No reflection-based DI — pure interface-based
