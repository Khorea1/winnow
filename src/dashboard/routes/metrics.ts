import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HealthEntry } from '../../health/index.js';
import { getProxyConnectionStats } from '../../proxy/server.js';
import type { DashboardRouteContext } from '../types.js';

export function handleMetricsRoute(req: IncomingMessage, res: ServerResponse, pathname: string, ctx: DashboardRouteContext): boolean {
  if (pathname !== '/metrics') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return true;
  }

  const now = Date.now();
  const entries = [...ctx.health.entries()];
  const alive = entries.filter(
    ([_raw, h]: [string, HealthEntry]) => h.frozenUntil <= now && h.bannedUntil <= now && h.errors < ctx.config.current.maxErrors,
  ).length;
  const connections = getProxyConnectionStats(ctx.server) ?? { active: 0, limit: ctx.config.current.maxConnections, rejected: 0 };
  const requests = ctx.getRequestMetrics?.() ?? { requests: 0, successes: 0, failures: 0, bytes: 0, latencyMs: 0 };
  // Fixed series: upstream addresses and target names are private and unbounded.
  const output = [
    '# HELP winnow_proxy_pool_total Configured proxies in the health store.',
    '# TYPE winnow_proxy_pool_total gauge',
    `winnow_proxy_pool_total ${entries.length}`,
    '# HELP winnow_proxy_pool_healthy Proxies currently eligible for selection.',
    '# TYPE winnow_proxy_pool_healthy gauge',
    `winnow_proxy_pool_healthy ${alive}`,
    '# HELP winnow_connections_active Active proxied HTTP requests and CONNECT tunnels.',
    '# TYPE winnow_connections_active gauge',
    `winnow_connections_active ${connections.active}`,
    '# HELP winnow_connections_limit Configured concurrent proxy connection limit.',
    '# TYPE winnow_connections_limit gauge',
    `winnow_connections_limit ${connections.limit}`,
    '# HELP winnow_connection_rejections_total Requests refused because connection capacity was exhausted.',
    '# TYPE winnow_connection_rejections_total counter',
    `winnow_connection_rejections_total ${connections.rejected}`,
    '# HELP winnow_requests_total Completed proxied requests by outcome.',
    '# TYPE winnow_requests_total counter',
    `winnow_requests_total{result="success"} ${requests.successes}`,
    `winnow_requests_total{result="failure"} ${requests.failures}`,
    '# HELP winnow_request_bytes_total Total bytes accounted by completed proxied requests.',
    '# TYPE winnow_request_bytes_total counter',
    `winnow_request_bytes_total ${requests.bytes}`,
    '# HELP winnow_request_latency_milliseconds_sum Cumulative latency of completed proxied requests.',
    '# TYPE winnow_request_latency_milliseconds_sum counter',
    `winnow_request_latency_milliseconds_sum ${requests.latencyMs}`,
    '',
  ].join('\n');
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(output);
  return true;
}
