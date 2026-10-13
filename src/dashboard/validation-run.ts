import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import { atomicRewrite } from '../atomicRewrite.js';
import { resolveDataDir } from '../config/index.js';
import { createValidationRun, finishValidationRun } from '../db/index.js';
import { createLogger } from '../logger.js';
import { appendUniqueProxies, pruneValidatedLines } from '../proxy/proxyFile.js';
import { buildOptionsFromConfig } from '../validator/index.js';
import { runValidation } from '../validator/runner.js';
import type { ProxyResult } from '../validator/types.js';
import { isSafeProxyFile } from './auth.js';
import { respondJson } from './http.js';
import { broadcast, maskEventProxy } from './sse.js';
import type { DashboardRegistrationContext, ValidationManager, ValidationOverrides } from './types.js';

const logger = createLogger('dashboard');

export function createValidationManager(ctx: DashboardRegistrationContext, sseClients: Set<ServerResponse>): ValidationManager {
  let _validationRunning = false;
  let _abortController: AbortController | null = null;

  async function startValidation(res: ServerResponse, custom: Partial<ValidationOverrides>) {
    if (_validationRunning) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Validation already running' }));
      return;
    }

    const cfg = ctx.config.current;
    const proxyFile = cfg.proxyFile;

    if (!isSafeProxyFile(proxyFile, resolveDataDir())) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsafe proxyFile' }));
      return;
    }

    if (!fs.existsSync(proxyFile)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy file not found' }));
      return;
    }

    const opts = buildOptionsFromConfig(cfg, {
      threads: custom.threads ?? cfg.validationThreads,
      mode: custom.mode ?? cfg.validationMode,
      baseUrl: custom.baseUrl ?? cfg.validationBaseUrl,
      maxLatency: custom.maxLatency ?? cfg.validationMaxLatency,
      connectTimeout: custom.connectTimeout ?? cfg.validationConnectTimeout,
      throttle: custom.throttle ?? cfg.validationThrottle,
      ttfbRatio: custom.ttfbRatio ?? cfg.validationTtfbRatio,
      insecure: custom.insecure ?? cfg.validationInsecure,
      strictTLS: custom.strictTLS ?? cfg.validationStrictTLS,
      anonCheck: custom.anonCheck ?? cfg.validationAnonCheck,
      tlsHost: custom.tlsHost ?? cfg.validationTlsHost,
      tlsPort: custom.tlsPort ?? cfg.validationTlsPort,
      maxGap: custom.maxGap ?? cfg.validationMaxGap,
    });

    _validationRunning = true;
    _abortController = new AbortController();
    const runId = createValidationRun(ctx.db, opts.mode, opts.threads);

    respondJson(res, { jobId: runId, mode: opts.mode, threads: opts.threads, started: Date.now() });

    broadcast(sseClients, 'validation:start', { jobId: runId, mode: opts.mode, threads: opts.threads });

    try {
      const content = await fs.promises.readFile(proxyFile, 'utf8');
      const proxies = content
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean)
        .filter((l: string) => !l.startsWith('#'));
      const uniq = Array.from(new Set(proxies));

      let validCount = 0;
      let invalidCount = 0;

      const onProgress = (result: ProxyResult, stats: { total: number; done: number; valid: number; invalid: number }) => {
        if (_abortController?.signal.aborted || result.error === 'aborted') return;
        const now = Date.now();
        if (result.valid) {
          const latency = result.latency || 300;
          ctx.health.recordSuccess(result.proxy, undefined, latency, now);
        } else {
          const err = new Error(result.error || 'validation failed');
          ctx.health.recordFailure(result.proxy, undefined, err, ctx.config.current, now);
        }

        const line = result.valid
          ? `[VALID] ${result.proxy} (${result.stage})`
          : `[INVALID] ${result.proxy} - ${result.error || 'error'} (${result.stage || '?'})`;

        broadcast(
          sseClients,
          'validation:progress',
          maskEventProxy({
            jobId: runId,
            proxy: result.proxy,
            valid: result.valid,
            error: result.error,
            stage: result.stage,
            done: stats.done,
            total: stats.total,
            validCount: stats.valid,
            invalidCount: stats.invalid,
            line,
          }),
        );
      };

      const result = await runValidation(uniq, opts, onProgress, _abortController.signal);

      if (_abortController.signal.aborted) throw new Error('aborted');

      validCount = result.valid.length;
      invalidCount = result.invalid.length;

      // Prune or append using the latest on-disk contents. Concurrent dashboard
      // mutations are serialized and additions made during validation survive.
      try {
        const prune = custom.prune ?? cfg.validationPrune;
        if (prune) {
          if (result.valid.length > 0) {
            const valid = new Set(result.valid);
            const checked = new Set(uniq);
            await atomicRewrite(proxyFile, (content) => pruneValidatedLines(content, checked, valid));
            logger.info({ kept: result.valid.length, removed: result.invalid.length }, 'pruned proxy file');
          } else {
            logger.info({}, 'no valid proxies, keeping original file');
          }
        } else {
          let added = 0;
          await atomicRewrite(proxyFile, (content) => {
            const update = appendUniqueProxies(content, result.valid);
            added = update.added;
            return update.content;
          });
          if (added) logger.info({ count: added }, 'auto-imported new proxies');
        }
      } catch (e: unknown) {
        logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'file update error');
      }
      // Clean up health entries for invalid proxies
      for (const p of result.invalid) {
        ctx.health.delete(p.proxy);
      }

      finishValidationRun(ctx.db, runId, uniq.length, validCount, invalidCount, 0);
      broadcast(sseClients, 'validation:complete', { jobId: runId, exitCode: 0, total: uniq.length, passed: validCount, failed: invalidCount });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg === 'aborted' || _abortController?.signal.aborted) {
        logger.info({}, 'validation aborted by user');
        finishValidationRun(ctx.db, runId, 0, 0, 0, 130);
        broadcast(sseClients, 'validation:complete', { jobId: runId, exitCode: 130, total: 0, passed: 0, failed: 0, stopped: true });
      } else {
        logger.warn({ error: errMsg }, 'validation error');
        finishValidationRun(ctx.db, runId, 0, 0, 0, 1);
        broadcast(sseClients, 'validation:complete', { jobId: runId, error: errMsg, exitCode: 1 });
      }
    } finally {
      _validationRunning = false;
      _abortController = null;
    }
  }

  return {
    start: startValidation,
    stop(res) {
      if (_abortController && _validationRunning) {
        _abortController.abort();
        broadcast(sseClients, 'validation:stopping', { stopping: true });
        respondJson(res, { stopped: true });
      } else {
        respondJson(res, { stopped: false, reason: 'not running' });
      }
    },
    isRunning: () => _validationRunning,
    abort: () => _abortController?.abort(),
  };
}
