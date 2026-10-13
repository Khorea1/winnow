import type { ServerResponse } from 'node:http';
import { type HealthEntry, HealthStore } from '../../health/index.js';
import { publicProxyKey } from '../../proxy/redact.js';
import { getProxyConnectionStats } from '../../proxy/server.js';
import { respondJson } from '../http.js';
import { proxyId } from '../proxyKey.js';
import type { DashboardRouteContext } from '../types.js';

export function handleStatsRoute(res: ServerResponse, pathname: string, ctx: DashboardRouteContext): boolean {
  if (pathname !== '/__stats') return false;
  const { health } = ctx;
  const cfgRef = ctx.config;

  const now = Date.now();
  const maxErrors = cfgRef.current.maxErrors ?? 3;
  const allEntries = [...health.entries()];
  const list = allEntries
    .map(([raw, h]: [string, HealthEntry]) => {
      const frozen = h.frozenUntil > now;
      const banned = now < h.bannedUntil;
      const score = frozen || banned ? Infinity : HealthStore.computeScore(h, now);
      return { id: proxyId(raw), proxy: publicProxyKey(raw), ...h, score, banned, frozen };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 50);
  const alive = allEntries.filter(([_raw, h]: [string, HealthEntry]) => {
    if (h.frozenUntil > now || now < h.bannedUntil || h.errors >= maxErrors) return false;
    return true;
  }).length;
  respondJson(res, {
    total: allEntries.length,
    alive,
    top: list,
    targets: cfgRef.current.targets,
    retries: cfgRef.current.retries,
    timeout: cfgRef.current.timeout,
    connections: getProxyConnectionStats(ctx.server) ?? { active: 0, limit: cfgRef.current.maxConnections, rejected: 0 },
    requestMetrics: ctx.getRequestMetrics?.() ?? { requests: 0, successes: 0, failures: 0, bytes: 0, latencyMs: 0 },
  });
  return true;
}
