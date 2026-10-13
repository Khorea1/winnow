# AGENTS.md — Winnow

## Project

Winnow is a Node.js/TypeScript forward HTTP/S proxy that rotates across an upstream proxy pool using persistent health data, per-target scoring, validation, and a live dashboard.

Primary sources of truth:

- `README.md`: supported behavior, architecture, configuration, API, security, and operational semantics.
- `package.json`: runtime requirement and canonical scripts.
- `src/`: implementation.
- `biome.json` and `tsconfig.json`: formatting/lint/type rules.

The package requires Node.js 22 or newer.

## Core contracts

- Health state is persistent SQLite state via `better-sqlite3`; do not treat it as disposable in-memory scoring.
- Proxy selection is score-based and may be target-specific. Preserve the distinction between per-target health and aggregate health.
- The proxy pool hot-reloads from the configured proxy file. Changes that rewrite that file must preserve atomic-update behavior where the current code relies on it.
- Failure classification drives ban/freeze behavior. Treat fatal/transient classification and its persisted consequences as user-visible behavior.
- TLS validation is a security boundary. Do not silently weaken certificate verification or change secure defaults for convenience.
- SSRF protections at HTTP/CONNECT dial boundaries are security-critical. Preserve blocking of private/loopback/local address space and hostname classes documented in the README unless an explicit product change says otherwise.
- Dashboard/API/SSE behavior shares live proxy and health state with the proxy server. Changes to event names or response contracts should be reflected in consumers and tests.
- Authentication for dashboard/API routes is controlled by the supported token environment variables. Avoid adding alternate bypass paths.

## Relevant structure

- `src/proxy/`: HTTP/S proxying, upstream dial, TLS handling.
- `src/health/`: health persistence, failure classification, scoring, selection inputs.
- `src/validator/`: multi-stage validation pipeline and CLI.
- `src/dashboard/`: dashboard HTTP API and SSE behavior.
- `src/config/`: config loading/sanitization/hot reload.
- `src/db/`: SQLite schema/queries.
- `public/html/`: dashboard HTML fragments; `npm run build:html` assembles them into `public/dashboard.html` via `scripts/assemble-html.mjs`. Edit the fragments and rebuild instead of hand-editing the assembled HTML.

Use nearby code and the README for the current package map rather than duplicating implementation detail here.

## Canonical commands

```sh
npm run build
npm run dev
npm run test
npm run typecheck
npm run lint
npm run check
npm run validator -- --help
```

`npm run check` is the normal combined local gate: Biome checks, TypeScript typecheck, and tests.

`npm run lint:fix` and `npm run format` mutate source files; use them only when scoped to the task.

## Generated/build output and local state

- `dist/` is build output; change TypeScript/source assets and rebuild rather than hand-editing compiled output.
- Health databases, proxy lists, `config.json`, validation output, and similar runtime files may contain local operational state. Do not commit machine-specific or sensitive copies unless they are intentional fixtures/examples.
- `better-sqlite3` includes a native component; keep Node/runtime compatibility in mind when changing packaging or deployment.

## Network and security-sensitive validation

Tests that reach arbitrary external targets or public proxies are environment-dependent and can be unsafe as deterministic CI coverage. Prefer repository tests and controlled fixtures for logic changes.

When a change affects TLS, SSRF filtering, proxy parsing/dialing, authentication, or file-rewrite behavior, add or run focused regression coverage for that boundary.

## Destructive/external operations

The validator can prune/rewrite proxy files, API deletion can remove proxies and health rows, and runtime commands can make real network connections. Inspect configuration and use test fixtures before exercising these paths against real data.

## Maintaining this file

Keep stable Winnow-specific constraints and pointers here. Do not record operator profiles, agent-memory systems, task journals, current machine/service state, or copied README sections that will drift.
