# Proxy Health Tiers: Fatal vs Transient Failure Handling

## Problem Statement

How might we ensure that structurally dead proxies (TLS/cert failures, connection refused) are frozen or pruned quickly, while intermittently failing proxies (timeouts, upstream 5xx) get a chance to recover — with configurable ban windows for both?

## Recommended Direction

**Two-tier health tracking with failure classification, backed by configurable ban parameters.**

Add a `fatalErrors` counter to each health entry. At every capture point where a failure occurs, classify the error as *fatal* (proxy is dead — connection refused, TLS failure, DNS failure, SOCKS protocol error) or *transient* (proxy is flaky — timeout, upstream 5xx, early close, connection reset during data transfer). Each counter has its own ban formula:

- **Fatal errors** → long ban, configurable (`fatalBanMs`, default 5 min). After N fatal errors (configurable `maxFatalErrors`, default 3), the proxy is frozen indefinitely (banned until manually cleared or auto-pruned).
- **Transient errors** → short ban, configurable (`banBaseMs`, `banMultiplier`, `banMaxMs`), same structure as current but now configurable and decoupled from fatal.

This means:
- A proxy that can't complete a TLS handshake → immediate 5-min freeze. After 3 such events → frozen forever (pruned after configurable `pruneAfterMs`).
- A proxy that 503s → 30s ban, backoff up to 3 min. Next health check might succeed and it's back.
- A proxy that works for one target but fails TLS for another → per-target fatal tracking handles this correctly via the existing per-target health rows.

The operator can tune all durations in `config.json` without touching code.

### Current Gaps Identified in Codebase

1. **HTTP proxy handler has zero error tracking** — `server.ts` CONNECT handler has `markFailure()`, but the HTTP proxy handler (`server.on('request')`) never records failures.
2. **Health checks swallow all errors** — `healthCheckTick()` has an empty `catch {}`; failed health checks don't increment any counter.
3. **`tryWithRetry` skips uninitialized proxies** — `if (!h) continue` silently drops failures for proxies without a health entry.
4. **Ban timers hardcoded in two places with different formulas** — `tryWithRetry` uses `min(120s, errors × 30s)`, `markFailure` uses `min(180s, errors × 40s)`.
5. **No error classification** — every failure is treated identically regardless of root cause.

### Changes Required

1. **Schema**: Add `fatal_errors` and `frozen` columns to `proxy_health`.
2. **HealthEntry**: Add `fatalErrors: number` and `frozenUntil: number` fields.
3. **Config**: Add `maxFatalErrors`, `fatalBanMs`, `banBaseMs`, `banMultiplier`, `banMaxMs`, `pruneAfterMs` keys.
4. **Error classification**: Add a `classifyError(e): 'fatal' | 'transient'` helper. Wire into `tryWithRetry`, `markFailure`, `healthCheckTick`, and the HTTP proxy handler.
5. **HTTP proxy handler**: Add failure tracking — currently missing entirely.
6. **HealthCheckTick**: Add error recording to the empty catch block.
7. **`tryWithRetry`**: Remove the `if (!h) continue` guard — initialize a new entry on first failure instead of silently dropping it.
8. **Auto-pruning**: Background check that removes proxies frozen longer than `pruneAfterMs`.

## Key Assumptions to Validate

- [ ] Error classification is reliable from the available `err.code` / `err.message` data — test with real proxies that exhibit each failure mode; confirm no false positives that would freeze good proxies
- [ ] Operators want automated pruning rather than manual curation — the current design keeps every proxy in the pool; pruning changes that assumption
- [ ] The "fatal vs transient" binary is sufficient — there isn't a third category (e.g., "target is down, not proxy") that needs different treatment

## MVP Scope

1. Health schema migration (add `fatal_errors`, `frozen`)
2. `classifyError()` helper + integration at all 5 capture points
3. Config keys with backwards-compatible defaults
4. Wire fatal errors into `isAlive()` and `scoreProxy()`
5. Fix the two data-loss bugs: empty `catch {}` in health check, missing tracking in HTTP handler
6. Replace hardcoded ban constants with config values

## Not Doing (and Why)

- **Health event log table** — useful for debugging but doesn't solve the retry problem directly. Can add later as observability layer.
- **Per-target fatal error differentiation** — the existing per-target health rows already handle this. If a proxy works for `httpbin.org` but fails TLS for `opencode.ai`, it gets per-target fatal errors and per-target bans. No extra work needed.
- **Auto-pruning in v1** — removing proxies from the pool is a policy decision that affects the proxy file. Start with freezing only. Pruning adds complexity around proxy file synchronization.
- **Dashboard UI changes** — the dashboard can show `fatalErrors` / `frozen` fields with minimal changes, but building a management UI for unbanning is out of scope.
- **ML-based failure prediction** — overkill. Rule-based classification is sufficient and transparent.

## Open Questions

- Should unbanning happen automatically after a cooldown period for fatal errors, or should frozen proxies require manual intervention via the dashboard/API?
- Should fatal errors from the *target* (e.g., the remote server's TLS cert is bad, not the proxy's) be treated differently? Currently both look like TLS failures.
- Should the proxy file be writable — so frozen/pruned proxies can be removed from the file and new ones added without restart?
