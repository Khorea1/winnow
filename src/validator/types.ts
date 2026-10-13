import type { RotatorConfig } from '../config/index.js';

export interface Timeouts {
  tcpMs: number;
  httpMs: number;
  tlsMs: number;
  streamMs: number;
}

export interface ValidatorOptions {
  threads: number;
  mode: RotatorConfig['validationMode'];
  baseUrl: string;
  timeouts: Timeouts;
  maxLatency: number;
  ttfbRatio: number;
  maxGap: number;
  insecure: boolean;
  strictTLS: boolean;
  anonCheck: boolean;
  throttle: number;
  tlsHost: string;
  tlsPort: number;
}

// The old CLI/dashboard connectTimeout input remains seconds at this boundary.
export type ValidatorOptionsOverrides = Partial<Omit<ValidatorOptions, 'timeouts'>> & { connectTimeout?: number };

export interface ProxyResult {
  proxy: string;
  valid: boolean;
  latency?: number;
  error?: string;
  stage?: string;
  httpCode?: number;
  ttfb?: number;
  chunks?: number;
}

/** Receives the raw proxy key for persistence; callers must redact it before displaying. */
export type ProgressCallback = (result: ProxyResult, stats: { total: number; done: number; valid: number; invalid: number }) => void;
