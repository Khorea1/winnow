import fs from 'node:fs';
import path from 'node:path';

// Config resolution path: WINNOW_CONFIG env > --config cli flag (set in index.ts) > default.
// Default respects WINNOW_DATA_DIR / DATA_DIR / cwd.
export function resolveDataDir(): string {
  const envDir = process.env.WINNOW_DATA_DIR || process.env.DATA_DIR;
  if (envDir?.trim()) return path.resolve(envDir.trim());
  return process.cwd();
}

export function getConfigPath(): string {
  const override = process.env.WINNOW_CONFIG;
  if (override?.trim()) return path.resolve(override.trim());
  return path.join(resolveDataDir(), 'config.json');
}

export interface RotatorConfig {
  port: number;
  proxyFile: string;
  targets: string[];
  retries: number;
  maxErrors: number;
  timeout: number;
  validationThreads: number;
  validationMode: 'quick' | 'standard' | 'strict' | 'stream';
  validationBaseUrl: string;
  validationMaxLatency: number;
  validationConnectTimeout: number;
  validationThrottle: number;
  validationTtfbRatio: number;
  validationAnonCheck: boolean;
  validationInsecure: boolean;
  validationStrictTLS: boolean;
  validationPrune: boolean;
  validationMaxGap: number;
  validationTlsHost: string;
  validationTlsPort: number;
  // Proxy Health Tiers — fatal vs transient failure classification
  maxFatalErrors: number;
  fatalBanMs: number;
  banBaseMs: number;
  banMultiplier: number;
  banMaxMs: number;
  pruneAfterMs: number;
  upstreamIdleTimeout: number;
}

const DEFAULTS: RotatorConfig = {
  port: 8080,
  proxyFile: 'proxies.txt',
  targets: ['httpbin.org:80', 'opencode.ai:443'],
  retries: 5,
  maxErrors: 3,
  timeout: 3500,
  validationThreads: 20,
  validationMode: 'quick',
  validationBaseUrl: 'http://httpbin.org',
  validationMaxLatency: 7000,
  validationConnectTimeout: 4,
  validationThrottle: 100,
  validationTtfbRatio: 100,
  validationAnonCheck: false,
  validationInsecure: false,
  validationStrictTLS: false,
  validationPrune: true,
  validationMaxGap: 5000,
  validationTlsHost: 'www.google.com',
  validationTlsPort: 443,
  // Proxy Health Tiers defaults
  maxFatalErrors: 3,
  fatalBanMs: 5 * 60 * 1000, // 5 min immediate ban after a fatal error
  banBaseMs: 30 * 1000, // 30s base ban for transient errors
  banMultiplier: 2, // exponential: ban = base * (multiplier ^ min(errors-1, k))
  banMaxMs: 3 * 60 * 1000, // 3 min cap on transient bans
  pruneAfterMs: 24 * 60 * 60 * 1000, // 24h — frozen proxy auto-pruned after this
  upstreamIdleTimeout: 0, // 0 = use timeout * 2 for idle timeout
};

const API_ALLOWED_KEYS = new Set<keyof RotatorConfig>([
  'port',
  'retries',
  'maxErrors',
  'timeout',
  'targets',
  'validationThreads',
  'validationMode',
  'validationBaseUrl',
  'validationMaxLatency',
  'validationConnectTimeout',
  'validationThrottle',
  'validationTtfbRatio',
  'validationAnonCheck',
  'validationInsecure',
  'validationStrictTLS',
  'validationPrune',
  'validationMaxGap',
  'validationTlsHost',
  'validationTlsPort',
  'maxFatalErrors',
  'fatalBanMs',
  'banBaseMs',
  'banMultiplier',
  'banMaxMs',
  'pruneAfterMs',
  'upstreamIdleTimeout',
]);

function clampInt(value: unknown, min: number, max: number, def: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return def;
}
function clampNum(value: unknown, min: number, max: number, def: number): number {
  return typeof value === 'number' && value >= min && value <= max ? value : def;
}
function ensureString(value: unknown, def: string, validate?: (s: string) => boolean): string {
  if (typeof value !== 'string' || !value.trim()) return def;
  const s = value.trim();
  return validate && !validate(s) ? def : s;
}
function ensureMode(value: unknown, def: 'quick' | 'standard' | 'strict' | 'stream'): 'quick' | 'standard' | 'strict' | 'stream' {
  const modes = new Set(['quick', 'standard', 'strict', 'stream']);
  return modes.has(value as string) ? (value as 'quick' | 'standard' | 'strict' | 'stream') : def;
}

function sanitize(cfg: Record<string, unknown>): RotatorConfig {
  const c = { ...DEFAULTS, ...cfg } as RotatorConfig;
  c.port = clampInt(c.port, 1, 65535, DEFAULTS.port);
  c.retries = clampInt(c.retries, 1, 20, DEFAULTS.retries);
  c.maxErrors = clampInt(c.maxErrors, 0, 100, DEFAULTS.maxErrors);
  c.timeout = clampNum(c.timeout, 500, 60000, DEFAULTS.timeout);
  c.validationThreads = clampInt(c.validationThreads, 1, 100, DEFAULTS.validationThreads);
  c.validationMode = ensureMode(c.validationMode, DEFAULTS.validationMode);
  c.validationBaseUrl = ensureString(c.validationBaseUrl, DEFAULTS.validationBaseUrl, (s) => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  });
  c.validationMaxLatency = clampInt(c.validationMaxLatency, 500, 30000, DEFAULTS.validationMaxLatency);
  c.validationConnectTimeout = clampInt(c.validationConnectTimeout, 1, 30, DEFAULTS.validationConnectTimeout);
  c.validationThrottle = clampInt(c.validationThrottle, 0, 5000, DEFAULTS.validationThrottle);
  c.validationTtfbRatio = clampInt(c.validationTtfbRatio, 1, 100, DEFAULTS.validationTtfbRatio);
  c.validationMaxGap = clampInt(c.validationMaxGap, 0, 60000, DEFAULTS.validationMaxGap);
  c.validationTlsHost = ensureString(c.validationTlsHost, DEFAULTS.validationTlsHost);
  c.validationTlsPort = clampInt(c.validationTlsPort, 1, 65535, DEFAULTS.validationTlsPort);
  c.maxFatalErrors = clampInt(c.maxFatalErrors, 1, 100, DEFAULTS.maxFatalErrors);
  c.fatalBanMs = clampNum(c.fatalBanMs, 1000, 7 * 24 * 60 * 60 * 1000, DEFAULTS.fatalBanMs);
  c.banBaseMs = clampNum(c.banBaseMs, 1000, 60 * 60 * 1000, DEFAULTS.banBaseMs);
  c.banMultiplier = clampNum(c.banMultiplier, 1, 10, DEFAULTS.banMultiplier);
  c.banMaxMs = clampNum(c.banMaxMs, Math.max(1000, c.banBaseMs), 24 * 60 * 60 * 1000, DEFAULTS.banMaxMs);
  c.pruneAfterMs = clampNum(c.pruneAfterMs, 60 * 1000, 30 * 24 * 60 * 60 * 1000, DEFAULTS.pruneAfterMs);
  c.validationInsecure = !!c.validationInsecure;
  c.validationStrictTLS = !!c.validationStrictTLS;
  c.validationPrune = c.validationPrune !== false;
  const trimmedTargets = Array.isArray(c.targets) ? (c.targets as string[]).map((t: string) => String(t).trim()).filter(Boolean) : [];
  c.targets = trimmedTargets.length ? trimmedTargets : DEFAULTS.targets;
  c.upstreamIdleTimeout = clampNum(c.upstreamIdleTimeout, 0, 120000, 0);
  c.proxyFile = ensureString(c.proxyFile, DEFAULTS.proxyFile, (s) => !s.includes('\0'));
  if (!path.isAbsolute(c.proxyFile)) c.proxyFile = path.resolve(resolveDataDir(), c.proxyFile);
  return c;
}

/**
 * Load configuration with the following precedence (lowest to highest):
 *   1. Compile-time DEFAULTS (lowest priority)
 *   2. JSON config file overrides
 *   3. Environment variable overrides (PROXY_FILE / WINNOW_PROXY_FILE, PORT / WINNOW_PORT,
 *      WINNOW_DATA_DIR / DATA_DIR, WINNOW_CONFIG)
 *   4. CLI argument overrides (applied in index.ts after loadConfig returns)
 *   5. sanitize() for bounds/validation (final pass)
 */

export function loadConfig(): RotatorConfig {
  const configPath = getConfigPath();
  let cfg: Record<string, unknown> = { ...DEFAULTS };
  try {
    if (fs.existsSync(configPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = { ...cfg, ...(parsed as Record<string, unknown>) };
    } else {
      const dir = path.dirname(configPath);
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch {}
      fs.writeFileSync(configPath, `${JSON.stringify(sanitize({ ...DEFAULTS }), null, 2)}\n`);
    }
  } catch (e: unknown) {
    console.warn('[CONFIG] Error reading config:', (e as Error).message);
  }
  if (process.env.PROXY_FILE?.trim()) cfg.proxyFile = process.env.PROXY_FILE;
  if (process.env.WINNOW_PROXY_FILE?.trim()) cfg.proxyFile = process.env.WINNOW_PROXY_FILE;
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10);
  if (process.env.WINNOW_PORT) cfg.port = parseInt(process.env.WINNOW_PORT, 10);
  return sanitize(cfg);
}

export function updateConfig(patch: Partial<RotatorConfig>): RotatorConfig {
  const configPath = getConfigPath();
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    /* vazio abaixo é tratado por sanitize */
  }
  for (const k of API_ALLOWED_KEYS) {
    if ((patch as Record<string, unknown>)[k] !== undefined) current[k] = (patch as Record<string, unknown>)[k];
  }
  const sanitized = sanitize(current);
  const dir = path.dirname(configPath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
  fs.writeFileSync(configPath, `${JSON.stringify(sanitized, null, 2)}\n`);
  return sanitized;
}
export { DEFAULTS };
