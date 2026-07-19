# Winnow

**Proxy rotator with persistent health tracking, multi-target scoring, validation pipeline, and real-time dashboard.**

Winnow is a forward HTTP/S proxy that maintains a health database for every proxy in your pool. It classifies failures as *fatal* (proxy is dead — connect refused, TLS error) or *transient* (proxy is flaky — timeout, upstream 5xx), applies exponential ban backoff, and scores proxies by latency and error history. The included validator runs multi-stage checks (TCP, HTTP, TLS, streaming) against each proxy to pre-qualify candidates.

## Features

- **HTTP CONNECT & HTTP GET** proxy modes
- **Multi-target health scoring** — per-target tracking when targets are known, pooled scoring otherwise
- **Fatal vs transient error classification** — connection refused, DNS failure, TLS errors → fatal; timeouts, upstream 5xx, resets → transient
- **Exponential ban backoff** with configurable base, multiplier, and cap
- **Fatal freeze** — proxies with repeated fatal errors are frozen until the configured ban window expires (survives restarts via SQLite)
- **Pruning** — auto-remove proxies that haven't been healthy beyond `pruneAfterMs`
- **Validation pipeline** — CLI tool with progressive check stages:
  - TCP reachability
  - HTTP request/response via proxy
  - TLS certificate validation (optional strict mode)
  - Light streaming (size threshold)
  - Heavy streaming + POST (strict mode only)
- **Real-time dashboard** — SSE-powered web UI with live event log, stats, and proxy table
- **REST API** — stats, health data, proxy management, config hot-reload
- **SSRF protection** — private ranges blocked at connect level
- **Docker** — multi-stage build with non-root user and healthcheck

## Quick start

```bash
npm install
npm run build
echo 'http://user:pass@1.2.3.4:3128' > proxies.txt
cp config.example.json config.json
# edit config.json — set proxyFile, targets, etc.
npm start
```

Point your browser to `http://localhost:8080/dashboard`.

### Docker

```bash
docker compose up --build -d
```

Volume mounts and environment variables are documented in `docker-compose.yml`.

## Configuration

Configuration is loaded from `config.json` (path customizable via `WINNOW_CONFIG` env or `--config` CLI flag). See `config.example.json` for all options.

Key settings:

| Field | Default | Description |
|---|---|---|
| `port` | `8080` | HTTP proxy listen port |
| `proxyFile` | `proxies.txt` | Path to proxy list (one per line, supports `http://`, `socks5://`, bare `host:port`) |
| `targets` | `["httpbin.org:80", "opencode.ai:443"]` | Target hosts for health checks and scoring |
| `retries` | `5` | Proxies to try per request |
| `timeout` | `3500` | Upstream connection timeout (ms) |
| `validationMode` | `"quick"` | `quick` (TCP+HTTP), `standard` (+streaming), `strict` (+heavy streaming+POST), `tcp-only` |

Fatal/transient tuning:

| Field | Default | Description |
|---|---|---|
| `maxFatalErrors` | `3` | Fatal errors before proxy is frozen |
| `fatalBanMs` | `300000` | Freeze duration after max fatal errors (5 min) |
| `banBaseMs` | `30000` | Base transient ban duration (30 s) |
| `banMultiplier` | `2` | Exponential multiplier per transient error |
| `banMaxMs` | `180000` | Max transient ban (3 min) |
| `pruneAfterMs` | `86400000` | Remove proxies unseen-healthy for this long (24 h) |

## CLI

```bash
# Start the proxy
npm start -- --port 9090 --proxyfile proxies.txt

# Run standalone validation
npm run validator -- --file proxies.txt --mode strict --json results.json

# Dev mode (hot reload via tsx)
npm run dev
```

### Standalone validator CLI flags

```
--file <path>         Proxy file to validate
--mode <mode>         quick | standard | strict | tcp-only
--threads <n>         Concurrent validation threads
--timeout <ms>        Request timeout
--base-url <url>      Base URL for HTTP checks
--max-latency <ms>    Maximum acceptable latency
--connect-timeout <s> TCP connect timeout (seconds)
--ttfb-ratio <n>      TTFB ratio threshold
--max-gap <ms>        Time gap check threshold
--json <path>         Write JSON results to file
--output <path>       Write valid proxies to file (one per line)
--insecure            Allow invalid TLS certificates
--strict-tls          Reject self-signed certificates
--anon-check          Verify proxy anonymity (X-Forwarded-For)
--throttle <ms>       Minimum delay between checks
--tls-host <host>     Target for explicit TLS check
--tls-port <port>     Port for explicit TLS check (default 443)
--help                Show help
```

## API endpoints

| Path | Method | Description |
|---|---|---|
| `/dashboard` | GET | Web UI dashboard |
| `/__stats` | GET | JSON stats summary + top proxies by score |
| `/api/config` | GET | Read current config |
| `/api/config` | POST | Hot-reload config |
| `/api/proxy?key=<key>` | DELETE | Remove a proxy (rewrites the proxy file + clears its health record) |
| `/api/events/log?limit=<n>` | GET | Recent event log (JSON) |
| `/events` | GET | Live event stream (SSE): `health:update`, `proxy:event`, `proxy:removed`, `validation:*` |
| `/api/validate` | GET | Recent validation runs |
| `/api/validate` | POST | Start validation run |
| `/api/validate/status` | GET | Whether a validation run is currently in progress |
| `/api/validate/stop` | POST | Cancel the running validation |

### Authentication

Set `WINNOW_TOKEN` (or `DASHBOARD_TOKEN` / `API_TOKEN`) to require a bearer token for all API and dashboard access.

## Proxy file format

One proxy per line. Supported schemes:

```
http://user:pass@host:port
socks5://host:1080
host:3128                 → defaults to http://
[::1]:8080                → IPv6 supported
```

Lines starting with `#` are ignored.

## Health state

Health data is persisted in SQLite alongside the proxy file (`proxies.db`). It survives restarts. The dashboard shows live scores, ban status, and last-seen info per proxy.

## Project structure

```
├── src/
│   ├── index.ts              Entry point, CLI parsing, graceful shutdown
│   ├── events.ts             In-memory event log with SSE subscriptions
│   ├── config/               Config loading, sanitization, hot-reload
│   ├── proxy/                HTTP/S proxy server, rotator, dial, TLS
│   ├── health/               Health store, error classification, scoring
│   ├── validator/            Multi-stage proxy validation pipeline
│   │   └── checks/           tcp, http, tls, streaming check stages
│   ├── dashboard/            HTTP API routes + SSE dashboard
│   ├── db/                   SQLite schema and queries
│   └── __tests__/            Unit tests (node:test)
├── public/
│   └── dashboard.html        Dashboard UI
├── Dockerfile                Multi-stage production build
├── docker-compose.yml        Example deployment
└── config.example.json       Documented configuration template
```

## License

GNU General Public License v3.0 or later — `SPDX: GPL-3.0-or-later`.
See [LICENSE](LICENSE).

This program is free software: you can redistribute and modify it under
the terms of the GPLv3 or any later version. In short: you may use, study,
share, and improve it. Any distributed modified version must also be free
software under GPLv3+. Commercial paywalled redistribution is not permitted.
