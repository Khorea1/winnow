import type http from 'node:http';
import type { ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { RotatorConfig } from '../config/index.js';
import type { EventLog } from '../events.js';
import type { HealthStore } from '../health/index.js';

export interface ValidationOverrides {
  threads?: number;
  mode?: 'quick' | 'standard' | 'strict' | 'stream' | 'tcp-only';
  baseUrl?: string;
  maxLatency?: number;
  connectTimeout?: number;
  throttle?: number;
  ttfbRatio?: number;
  maxGap?: number;
  insecure?: boolean;
  strictTLS?: boolean;
  anonCheck?: boolean;
  tlsHost?: string;
  tlsPort?: number;
  prune?: boolean;
}

export interface DashboardRegistrationContext {
  config: { current: RotatorConfig };
  health: HealthStore;
  db: Database.Database;
  eventLog?: EventLog;
  onConfigChange?: (updated: RotatorConfig) => void;
  getRequestMetrics?: () => { requests: number; successes: number; failures: number; bytes: number; latencyMs: number };
}

export interface ValidationRunManager {
  start(res: ServerResponse, custom: Partial<ValidationOverrides>): Promise<void>;
  stop(res: ServerResponse): void;
  isRunning(): boolean;
  abort(): void;
}

export interface DashboardRouteContext {
  server: http.Server;
  config: { current: RotatorConfig };
  health: HealthStore;
  db: Database.Database;
  eventLog: EventLog | undefined;
  onConfigChange: ((updated: RotatorConfig) => void) | undefined;
  getRequestMetrics: (() => { requests: number; successes: number; failures: number; bytes: number; latencyMs: number }) | undefined;
  sseClients: Set<ServerResponse>;
  validation: ValidationRunManager;
}
