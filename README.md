# Winnow

[![CI](https://github.com/Khorea1/winnow/actions/workflows/ci.yml/badge.svg)](https://github.com/Khorea1/winnow/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Node.js >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**A forward HTTP/S proxy that rotates across a pool of upstream proxies, scoring each one in real time and routing your traffic through the healthiest proxies available. One stable endpoint in front of dozens, hundreds, or thousands of proxies — a "proxy of proxies".**

Winnow classifies every failure as *fatal* (the proxy itself is structurally dead — refusals, DNS, TLS/cert, SOCKS protocol errors) or *transient* (the proxy is reachable but flaky — timeouts, upstream 5xx, resets). It freezes dead proxies, briefly bans flaky ones, scores the survivors, and keeps your requests flowing through the best of the pool. A persistent SQLite health database, a multi-stage validation pipeline, and a live dashboard ship with it.

<details>
<summary><strong>Table of contents</strong></summary>

- [Why "Winnow"](#why-winnow)
- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CLI](#cli)
- [API endpoints](#api-endpoints)
- [Proxy file format](#proxy-file-format)
- [Health state](#health-state)
- [Project structure](#project-structure)
- [License](#license)

</details>

---

## Why "Winnow"

To **winnow** is to separate the wheat from the chaff — to blow air through grain so the useless husks fly away and only the good kernels remain.

That is exactly what this project does to a proxy pool. Most public proxy lists are 80–95% dead, flaky, MITM-ing, or transparent. A flat list of proxies is not usable as-is. Winnow runs every candidate through a validation pipeline, classifies failures, discards the ones that cannot be trusted, scores the ones that remain, and routes your traffic only through the wheat.

The name is also a deliberate counterweight to tools that call themselves "rotator" and just round-robin through whatever list you gave them. Winnow is a *rotator that filters*: selection is by score, not by position in the file, and the worst proxies are pushed out of the pool automatically.

---

## Features

- **Single rotating endpoint ("proxy of proxies")** — expose one HTTP proxy address; Winnow dials upstream proxies behind it and retries across the pool automatically.
- **Score-based proxy selection, not naive round-robin** — every request and every health check picks the *N* healthiest proxies (by score) and shuffles among them. Hot proxies get more traffic; dying ones get less.
- **Periodic pool health checks** — a background tick dials a random target through the top proxies and records success/failure, latency, and TLS validity. Keeps scores fresh even when traffic is idle.
- **Fatal vs transient failure classification** — connection refused, DNS failure, TLS/cert errors, SOCKS protocol errors → *fatal*; timeouts, upstream 5xx, early close, resets → *transient. Each class has its own ban formula.*
- **Exponential ban backoff** — transient failures ban with `banBaseMs × banMultiplier^(errors-1)`, capped at `banMaxMs`. Operators tune every duration in `config.json` without touching code.
- **Fatal freeze** — after `maxFatalErrors` fatal events, the proxy is frozen for `fatalBanMs × 3` and excluded from rotation until thawed. Survives restarts via SQLite.
- **Bootstrap thaw** — on boot, frozen rows are demoted to a finite ban (so the proxy gets another chance) and `fatalErrors` is halved; one more fatal re-freezes.
- **Auto-pruning of the pool** — proxies unseen-healthy beyond `pruneAfterMs` are demoted from the rotation. The validator can rewrite the proxy file to keep only validated entries (`validationPrune`).
- **Hot-reloaded proxy pool** — the proxy file is watched with `fs.watch` (inotify on Linux). Append a line, save the file — the new proxy is live within milliseconds, with zero restart.
- **TLS integrity verification** — health checks against TLS targets perform a real handshake and validate the certificate chain. Self-signed and MITM certificates are **rejected by default**; opt in to lenient mode with `validationInsecure`/`--insecure` or opt into strict validation with `validationStrictTLS`/`--strict-tls`.
- **Multi-stage validation pipeline** — progressive stages: TCP reachability → HTTP request/response via proxy → explicit TLS check → light streaming → heavy streaming + POST (strict mode only). Run standalone from the CLI or trigger a run from the dashboard.
- **Real-time dashboard** — SSE-powered web UI with live event log, pool stats, score-sorted proxy table, spectrum bar, and validation runner. English and Portuguese, auto-detected from the browser.
- **REST API** — stats, health data, proxy removal, config hot-reload, validation runs.
- **SSRF protection** — private ranges (`127/8`, RFC 1918, link-local, RFC 6598), `localhost`, `*.local`, `*.internal`, and IPv6 loopback are blocked at the CONNECT/HTTP dial layer.
- **HTTP CONNECT and HTTP GET proxy modes** — tunnels HTTPS via CONNECT and forwards plain HTTP via GET, with hop-by-hop header filtering per RFC 2616 §13.5.1.
- **Docker** — multi-stage build, non-root user, `__stats` healthcheck, persistent volume.

---

## How it works

```mermaid
flowchart LR
    Client -->|request / CONNECT| Winnow["Winnow single endpoint"]
    subgraph Pool["Proxy pool (hot-reloaded from proxies.txt)"]
      P1["proxy A — score 240"]
      P2["proxy B — score 410"]
      P3["proxy C — frozen ❄"]
      P4["proxy D — banned ⏸"]
    end
    Winnow -->|pick top-N by score, shuffle, retry| P1
    Winnow -.-> P2
    HealthCheck["periodic health-check tick (every 15s)"] --> P1
    HealthCheck --> P2
    Winnow --> Target
    P1 --> Target
    SQLite[("SQLite health.db")] -.records.-> Winnow
    SQLite -.records.-> HealthCheck
    Dashboard["/dashboard + SSE"] -.live events.-> Winnow
```

### One endpoint, many proxies

Clients talk to `http://your-host:8080` as if it were a normal HTTP proxy. For each request Winnow:

1. Resolves the target host/port.
2. Calls `pickMany(proxies, health, retries, target)` — see selection below.
3. Dials each candidate in turn; the first successful upstream wins.
4. Records `recordSuccess` (latency) or `recordFailure` (classify → fatal/transient → ban/freeze) for the proxy that was tried.
5. Streams the response back to the client.

If every candidate fails, the client receives the last upstream error.

### Pool selection: score-ranked, not round-robin

`pickMany` (in `src/proxy/rotator.ts`) does **not** rotate by position. It:

1. Filters to proxies that are currently **alive** (not frozen, not banned, `errors < maxErrors`) for the target if the target is tracked, otherwise by the `*` aggregate.
2. **Sorts by ascending `scoreProxy`** — lower is better. Frozen or banned proxies return `Infinity` and drift to the bottom.
3. Takes the top `N` (defaults to `retries` for live requests, 10 for health checks).
4. Performs a **Fisher–Yates shuffle** within that top slice — so the best proxies share traffic but no single proxy is hammered deterministically.

For tracked targets, scores are per-target; for ad-hoc targets, the `*` aggregate is used. This keeps a proxy that works for `httpbin.org:80` but fails TLS to `opencode.ai:443` from being globally penalized.

### Score formula

`HealthStore.computeScore` (in `src/health/index.ts`):

```
frozenUntil > now        → ∞   (not selectable)
bannedUntil  > now        → ∞   (not selectable)
otherwise                → latency + errors × 2000 + fatalErrors × 10000 − successes × 50
```

- `latency` is an EMA: `latency = latency × 0.7 + sample × 0.3` (and adopts the first sample outright).
- `errors` (transient count) decays by one on each success — a recovery earns trust back.
- `fatalErrors` is durable; only the boot-time thaw halves it.
- `successes` is a long-run trust signal — many successes make a proxy resilient to one bad sample.

The net behavior: a fast, reliable proxy scores low and stays at the top of the rotation; a slow or error-prone proxy scores high and gets pushed down; a frozen or banned proxy is unreachable from the picker entirely until it thaws.

### Failure classification — fatal vs transient

`classifyError` (in `src/health/index.ts`) inspects `err.code`, `err.message`, and SOCKS reply bytes:

| Class | Cause examples | Effect |
|---|---|---|
| **Fatal** | `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `ERR_TLS_*`, SOCKS replies 0x01–0x05/0x07/0x08, message regex `\b(TLS\|SSL\|certificate\|self-signed\|handshake\|SOCKS\|protocol error)\b` | `fatalErrors++`; if `< maxFatalErrors` → banned for `fatalBanMs`; at `maxFatalErrors` → frozen for `fatalBanMs × 3` |
| **Transient** | `ETIMEDOUT`, upstream 5xx, `socket hang up`, early close, read resets | `errors++`; banned for `transientBanMs(errors)` (exponential, capped at `banMaxMs`) |

Transient ban duration: `ban = min(banBaseMs × banMultiplier^(min(errors-1, 6)), banMaxMs)`. With defaults (30s × 2^(k-1), cap 3min): 30s → 60s → 120s → 180s → 180s …

A success decays transient `errors` by 1 and clears `bannedUntil`. Fatal counters are only reset by the boot thaw (`_pruneFrozenOnBoot`), which converts any still-frozen row into a finite `min(pruneAfterMs, fatalBanMs × 3)` ban and halves `fatalErrors` — so one more fatal re-freezes instead of being silently ignored.

### Hot-reloaded proxy pool

In `src/index.ts`, `fs.watch(config.proxyFile, () => load())` reloads the file on every change. Linux uses inotify, so the reload is near-instant (not a polling interval). To **add a proxy**: append one line to `proxies.txt`, save — the new entry is parsed, added to the in-memory pool, and starts scoring on the next request. To **remove**: edit the file, or `DELETE /api/proxy?key=...` which rewrites the file atomically (temp + rename) and clears the health row.

Comments (lines starting with `#`) and blank lines are preserved across the rewrite, so operator annotations survive.

### Admit, validate, remove, freeze

| Action | How |
|---|---|
| **Admit** | Append a line to `proxies.txt`. The file watcher picks it up; the proxy starts with a blank health entry (`latency=9999`). It will be tried on the next request or health-check tick. |
| **Validate** | Run `npm run validator` (CLI) or `POST /api/validate` (dashboard). Each proxy passes through TCP → HTTP → optional TLS → optional streaming stages. Successful proxies record a success; failed proxies record a failure against `*`. With `validationPrune: true`, the proxy file is rewritten to keep only validated entries (atomic temp+rename; nothing is lost if zero survive — the original is kept). |
| **Remove** | `DELETE /api/proxy?key=<sanitized-url>` rewrites the proxy file without the line, deletes its health row, and broadcasts `proxy:removed` over SSE. Manual `proxies.txt` edits work too via the file watcher. |
| **Freeze / ban** | Automatic. Repeated fatal errors freeze the proxy for `fatalBanMs × 3`. Transient errors ban it on an exponential curve. Frozen/banned proxies are invisible to the picker and shown distinctly in the dashboard. |
| **Thaw** | On boot, frozen rows are demoted to a finite ban and `fatalErrors` is halved. During a run, a frozen proxy stays frozen — there is no mid-run unban, by design: a structurally dead proxy should not be retried until the operator restarts or prunes. |

### TLS verification (anti-MITM)

There are two layers of TLS checking:

1. **In the live proxy server (`src/proxy/tls.ts`)** — `tlsHandshake` connects with `rejectUnauthorized` honored by default. For health-check ticks, if the target is TLS (port 443), Winnow performs a full handshake and rejects when `validationStrictTLS` is set. Self-signed detection lives in `isSelfSignedError`, which recognizes `self signed`, `unable to verify`, `unable to get local issuer`, `certificate has expired`, and `depth_zero_self_signed` reasons.
2. **In the validator pipeline (`src/validator/checks/tls.ts`)** — when `--strict-tls` (or `validationStrictTLS: true`) is set, the validator dials an explicit TLS host (`validationTlsHost`, default `www.google.com:443`) through the proxy, handshakes, and rejects any unauthorized result. The proxy is marked invalid at the `tls` stage. Without strict mode, the TLS check is informational; with it, a MITM'ing or misconfigured proxy cannot pass validation.

**Defaults:** `validationInsecure: false` (the live handshake does not silently accept bad certs) and `validationStrictTLS: false` (the validator does not gate on the explicit TLS check unless you ask). To enforce strict certificate validation end-to-end, set both `validationInsecure: false` and `validationStrictTLS: true`.

### Periodic health checks

`src/index.ts` runs `healthCheckTick` every 15 seconds via `setInterval`. Each tick:

1. Picks a **random target** from `config.targets` (round-robins through the target list probabilistically — every target gets sampled over time).
2. Calls `pickMany(proxies, health, 10, target, maxErrors + 10)` — the **top 10 proxies for that target by score**, shuffled.
3. Dials each one. For TLS targets (port 443), performs the TLS handshake and rejects on cert failure.
4. Records `recordSuccess` (with measured latency) or `recordFailure`.

The check is skippable if no targets are configured. It uses an `_hcRunning` guard so ticks never overlap.

### Multi-stage validation pipeline

`src/validator/runner.ts` walks each proxy through stages in order based on mode:

| Mode | Stages |
|---|---|
| `tcp-only` | TCP reachability only |
| `quick` (default) | TCP + HTTP `/ip` (status, latency, content, optional anonymity) |
| `standard` | quick + light streaming (TTFB, chunk cadence, max gap) |
| `stream` | standard alias |
| `strict` | standard + explicit TLS check + heavy streaming + POST — full belt-and-suspenders |

Stages abort early on failure and on `AbortSignal`. The CLI flags mirror the dashboard's `POST /api/validate` overrides.

### Dashboard and real-time events

The dashboard is a single `dashboard.html` served at `/dashboard`, with a live SSE feed at `/events`. The server emits `health:update` (per proxy/target), `proxy:event` (ban, freeze, unban, retry, healthcheck, pool status, validation progress), `proxy:removed`, and `validation:*` events. The UI auto-detects language (Portuguese or English) from the browser, shows live pool stats, a spectrum bar of sample proxy health, a score-sorted proxy table, and a one-click validation runner.

CSP is set on the dashboard response; SSE connections are capped at 100 clients to bound resource use.

---

## Quick start

```bash
npm install
npm run build
echo 'http://user:pass@1.2.3.4:3128' > proxies.txt
cp config.example.json config.json
# edit config.json — set proxyFile, targets, etc.
npm start
```

Point your browser to `http://localhost:8080/dashboard`. Use Winnow as your HTTP proxy at `http://localhost:8080`.

### Docker

```bash
docker compose up --build -d
```

`docker-compose.yml` mounts a persistent volume at `/srv/data` (where `config.json` and `proxies.txt` live), exposes `8080`, and runs a `__stats` healthcheck. Bind-mount your own `proxies.txt` if you prefer external editing.

---

## Configuration

Loaded from `config.json` (path overridden by `WINNOW_CONFIG` env or `--config` CLI flag), with priority **CLI flag > env var > file > built-in defaults**. See `config.example.json` for the full template.

### Core

| Field | Default | Description |
|---|---|---|
| `port` | `8080` | HTTP proxy listen port |
| `proxyFile` | `proxies.txt` | Path to proxy list (one per line; supports `http://`, `socks5://`, bare `host:port`; comments with `#`) |
| `targets` | `["httpbin.org:80", "opencode.ai:443"]` | Target hosts for periodic health checks and per-target scoring (`host:port`) |
| `retries` | `5` | Proxies tried per request (top-N by score) |
| `maxErrors` | `3` | Transient errors before a proxy is excluded from rotation |
| `timeout` | `3500` | Upstream connection timeout (ms) |

### Fatal/transient tuning

| Field | Default | Description |
|---|---|---|
| `maxFatalErrors` | `3` | Fatal errors before a proxy is frozen |
| `fatalBanMs` | `300000` | Per-fatal ban (5 min); freeze duration is `fatalBanMs × 3` |
| `banBaseMs` | `30000` | Base transient ban (30 s) |
| `banMultiplier` | `2` | Exponential multiplier per transient error (clamped at exponent 6) |
| `banMaxMs` | `180000` | Max transient ban (3 min) |
| `pruneAfterMs` | `86400000` | Boot-thaw demotion cap; proxies unseen-healthy beyond this drift out of rotation (24 h) |
| `upstreamIdleTimeout` | `0` | Idle timeout on established upstream sockets; `0` → `timeout × 2` |

### Validation

| Field | Default | Description |
|---|---|---|
| `validationThreads` | `20` | Concurrent validation workers |
| `validationMode` | `quick` | `quick` / `standard` / `strict` / `stream` / `tcp-only` |
| `validationBaseUrl` | `http://httpbin.org` | Base URL for the HTTP check stage |
| `validationMaxLatency` | `7000` | Max acceptable HTTP latency (ms) |
| `validationConnectTimeout` | `4` | TCP connect timeout (seconds) |
| `validationThrottle` | `100` | Minimum delay between checks (ms) |
| `validationTtfbRatio` | `100` | TTFB ratio threshold for streaming |
| `validationAnonCheck` | `false` | Verify anonymity (reject transparent proxies leaking `X-Forwarded-For`) |
| `validationInsecure` | `false` | Allow invalid TLS certs (anti-MITM **off** when true) |
| `validationStrictTLS` | `false` | Gate validation on explicit TLS check; reject self-signed/unauthorized |
| `validationPrune` | `true` | Rewrite the proxy file to keep only validated entries |
| `validationMaxGap` | `5000` | Streaming max-gap threshold (ms) |
| `validationTlsHost` | `www.google.com` | Explicit TLS check target host |
| `validationTlsPort` | `443` | Explicit TLS check target port |

---

## CLI

```bash
# Start the proxy
npm start -- --port 9090 --proxyfile proxies.txt

# Run standalone validation
npm run validator -- --file proxies.txt --mode strict --json results.json

# Dev mode (tsx hot-reload of source)
npm run dev
```

Short flags: `-p` port, `-f` proxyfile, `-c` config, `-v` validationmode, `-t` timeout, `-d` datadir.

### Standalone validator CLI flags

Any flag left unset falls back to the matching `validation*` field in `config.json`, then to the built-in default — the CLI reads the same config file the server does, so tuning `config.json` affects both.

```
-f, --file <path>         Proxy file to validate
-m, --mode <mode>         quick | standard | strict | tcp-only | stream
-t, --threads <n>         Concurrent validation threads
    --timeout <ms>        Request timeout (alias for --max-latency)
-b, --base-url <url>      Base URL for HTTP checks
    --max-latency <ms>    Maximum acceptable latency
    --connect-timeout <s> TCP connect timeout (seconds)
    --ttfb-ratio <n>      TTFB ratio threshold
    --max-gap <ms>        Time gap check threshold
    --json <path>         Write JSON results to file
-o, --output <path>       Write valid proxies to file (one per line)
-i, --insecure            Allow invalid TLS certificates
-s, --strict-tls          Reject self-signed / unauthorized certificates
-a, --anon-check          Verify proxy anonymity (X-Forwarded-For)
-T, --throttle <ms>       Minimum delay between checks
    --tls-host <host>     Target for explicit TLS check
    --tls-port <port>     Port for explicit TLS check (default 443)
-h, --help                Show help
```

---

## API endpoints

| Path | Method | Description |
|---|---|---|
| `/dashboard` | GET | Web UI dashboard |
| `/__stats` | GET | JSON stats: total, alive, top-50 proxies by score, current config snapshot |
| `/api/config` | GET | Read current config |
| `/api/config` | POST | Hot-reload config (sanitized, allow-listed keys only) |
| `/api/proxy?key=<key>` | DELETE | Remove a proxy (rewrites the proxy file atomically + clears health row + SSE `proxy:removed`) |
| `/api/events/log?limit=<n>` | GET | Recent event log (JSON) |
| `/events` | GET | Live event stream (SSE): `health:update`, `proxy:event`, `proxy:removed`, `validation:*` |
| `/api/validate` | GET | Recent validation runs (last 20) |
| `/api/validate` | POST | Start a validation run (optional JSON body overrides threads, mode, baseUrl, strictTLS, insecure, prune, etc.) |
| `/api/validate/status` | GET | Whether a validation run is currently in progress |
| `/api/validate/stop` | POST | Cancel the running validation (aborts the AbortSignal) |

### Authentication

Set `WINNOW_TOKEN` (or the aliases `DASHBOARD_TOKEN` / `API_TOKEN`) to require a bearer token for all `/api/`, `/dashboard`, `/events`, and `/__stats` access. Without it, all routes are open.

---

## Proxy file format

One proxy per line. Supported schemes:

```
http://user:pass@host:port
socks5://host:1080
host:3128                 → defaults to http://
[::1]:8080                → IPv6 supported
```

Lines starting with `#` are ignored and preserved across atomic rewrites. Comments and blank lines survive `DELETE /api/proxy` and `validationPrune` operations.

---

## Health state

Health data is persisted in SQLite (`<proxyfile-basename>.db`, e.g. `proxies.db` for `proxies.txt`) alongside the proxy file. It survives restarts. Schema: one row per `(proxy, target)` pair plus a `*` aggregate row per proxy. The dashboard shows live scores, ban/freeze status, and last-seen info per proxy.

---

## Project structure

```
├── src/
│   ├── index.ts              Entry point, CLI parsing, file watch, shutdown
│   ├── events.ts             In-memory event log with SSE subscriptions
│   ├── config/               Config loading, sanitization, hot-reload
│   ├── proxy/                HTTP/S proxy server, rotator, dial, TLS
│   ├── health/               Health store, error classification, scoring
│   ├── validator/            Multi-stage proxy validation pipeline
│   │   └── checks/           tcp, http, tls, streaming stages
│   ├── dashboard/            HTTP API routes + SSE dashboard
│   ├── db/                   SQLite schema and queries
│   └── __tests__/            Unit tests (node:test)
├── public/
│   └── dashboard.html        Dashboard UI (PT/EN, auto-detected)
├── Dockerfile                Multi-stage production build
├── docker-compose.yml        Example deployment
└── config.example.json       Documented configuration template
```

---

## License

GNU General Public License v3.0 or later — `SPDX: GPL-3.0-or-later`.
See [LICENSE](LICENSE).

This program is free software: you can redistribute and modify it under
the terms of the GPLv3 or any later version. In short: you may use, study,
share, and improve it. Any distributed modified version must also be free
software under GPLv3+. Commercial paywalled redistribution is not permitted.
