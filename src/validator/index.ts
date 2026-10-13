import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { clampInt, loadConfig } from '../config/index.js';
import { createLogger } from '../logger.js';
import { runValidation } from './runner.js';
import type { ProgressCallback, ValidatorOptions } from './types.js';

const logger = createLogger('validator');
const HTTP_RESPONSE_GRACE_MS = 5000;
const STREAM_TIMEOUT_MS = 25000;
const STRICT_STREAM_TIMEOUT_MS = 35000;

interface ValidationConfigFragment {
  validationThreads?: number;
  validationMode?: 'quick' | 'standard' | 'strict' | 'stream' | 'tcp-only';
  validationBaseUrl?: string;
  validationConnectTimeout?: number;
  validationMaxLatency?: number;
  validationTtfbRatio?: number;
  validationMaxGap?: number;
  validationInsecure?: boolean;
  validationStrictTLS?: boolean;
  validationAnonCheck?: boolean;
  validationThrottle?: number;
  validationTlsHost?: string;
  validationTlsPort?: number;
}

export function buildOptionsFromConfig(config: ValidationConfigFragment, overrides: Partial<Omit<ValidatorOptions, 'timeouts'>> = {}): ValidatorOptions {
  const validModes = ['quick', 'standard', 'strict', 'stream', 'tcp-only'] as const;
  type ValidMode = (typeof validModes)[number];
  const configMode = config.validationMode && validModes.includes(config.validationMode as ValidMode) ? (config.validationMode as ValidMode) : undefined;
  if (!configMode && config.validationMode) {
    logger.warn({ mode: config.validationMode }, 'invalid validationMode, falling back to quick');
  }
  const mode =
    overrides.mode && validModes.includes(overrides.mode as ValidMode)
      ? (overrides.mode as ValidMode)
      : (() => {
          if (overrides.mode && !validModes.includes(overrides.mode as ValidMode)) {
            logger.warn({ mode: overrides.mode }, 'invalid CLI validation mode, falling back to config/default');
          }
          return configMode ?? 'quick';
        })();
  const connectTimeout = clampInt(overrides.connectTimeout, 1, 30, clampInt(config.validationConnectTimeout, 1, 30, 4));
  const maxLatency = clampInt(overrides.maxLatency, 500, 30000, clampInt(config.validationMaxLatency, 500, 30000, 7000));
  return {
    threads: overrides.threads ?? config.validationThreads ?? 20,
    mode,
    baseUrl: overrides.baseUrl ?? config.validationBaseUrl ?? 'http://httpbin.org',
    connectTimeout,
    maxLatency,
    timeouts: {
      tcpMs: connectTimeout * 1000,
      httpMs: maxLatency + HTTP_RESPONSE_GRACE_MS,
      tlsMs: connectTimeout * 1000,
      streamMs: mode === 'strict' ? STRICT_STREAM_TIMEOUT_MS : STREAM_TIMEOUT_MS,
    },
    ttfbRatio: overrides.ttfbRatio ?? config.validationTtfbRatio ?? 100,
    maxGap: overrides.maxGap ?? config.validationMaxGap ?? 5000,
    insecure: overrides.insecure ?? config.validationInsecure ?? false,
    strictTLS: overrides.strictTLS ?? config.validationStrictTLS ?? true,
    anonCheck: overrides.anonCheck ?? config.validationAnonCheck ?? true,
    throttle: overrides.throttle ?? config.validationThrottle ?? 100,
    tlsHost: overrides.tlsHost ?? config.validationTlsHost ?? 'www.google.com',
    tlsPort: overrides.tlsPort ?? config.validationTlsPort ?? 443,
  };
}

export async function validateFile(filePath: string, opts: ValidatorOptions, onProgress?: ProgressCallback, abortSignal?: AbortSignal) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stat = fs.statSync(filePath);
  if (stat.size > 10 * 1024 * 1024) throw new Error('File too large');
  const uniqSet = new Set<string>();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) uniqSet.add(trimmed);
  }
  const uniq = Array.from(uniqSet);

  const result = await runValidation(uniq, opts, onProgress, abortSignal);

  return {
    total: uniq.length,
    valid: result.valid,
    invalid: result.invalid,
    results: result.results,
  };
}

export async function cliMain() {
  const args = process.argv.slice(2);
  let proxyFile = '';
  let output = '';
  let jsonOutput = '';
  // Overrides start undefined so unset flags fall through to config.json / built-in defaults
  // (see buildOptionsFromConfig), instead of silently clobbering them with hardcoded values.
  const overrides: Partial<ValidatorOptions> = {};

  const nextArg = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) {
      logger.error({}, `missing value for ${flag}`);
      throw new Error(`missing value for ${flag}`);
    }
    return v;
  };
  const nextInt = (i: number, flag: string): number => {
    const n = parseInt(nextArg(i, flag), 10);
    if (!Number.isFinite(n)) {
      logger.error({}, `invalid number for ${flag}`);
      throw new Error(`invalid number for ${flag}`);
    }
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help' || a === '--ajuda') {
      console.log(`
Usage: validator [options] [<proxy-file>]

Options:
  --file <path>         Proxy file to validate
  --mode <mode>         quick | standard | strict | tcp-only | stream
  --threads <n>         Concurrent validation threads
  --timeout <ms>        Latency threshold (alias for --max-latency)
  --base-url <url>      Base URL for HTTP checks
  --max-latency <ms>    Maximum acceptable latency (500-30000 ms)
  --connect-timeout <s> TCP and TLS timeout (1-30 whole seconds)
  --ttfb-ratio <n>      TTFB ratio threshold
  --max-gap <ms>        Time gap check threshold
  --json <path>         Write JSON results to file
  --output <path>       Write valid proxies to file (one per line)
  --insecure            Allow invalid TLS certificates
  --strict-tls          Reject self-signed / unauthorized certificates
  --anon-check          Verify proxy anonymity (X-Forwarded-For)
  --throttle <ms>       Minimum delay between checks
  --tls-host <host>     Target for explicit TLS check
  --tls-port <port>     Port for explicit TLS check (default 443)
  --help                Show this help message

Unset options fall back to config.json, then to built-in defaults.

Examples:
  node dist/validator/index.js proxies.txt
  node dist/validator/index.js --file proxies.txt --mode strict --json results.json
`);
      process.exit(0);
    }
    if (a === '-f' || a === '--file') {
      proxyFile = nextArg(i, a);
      i++;
      continue;
    }
    if (a === '-t' || a === '--threads') {
      overrides.threads = nextInt(i, a);
      i++;
      continue;
    }
    if (a === '-o' || a === '--output') {
      output = nextArg(i, a);
      i++;
      continue;
    }
    if (a === '--json' || a === '-j' || a === '--json-output') {
      jsonOutput = nextArg(i, a);
      i++;
      continue;
    }
    if (a === '-m' || a === '--mode') {
      overrides.mode = nextArg(i, a) as ValidatorOptions['mode'];
      i++;
      continue;
    }
    if (a === '-b' || a === '--base-url') {
      overrides.baseUrl = nextArg(i, a);
      i++;
      continue;
    }
    if (a === '--timeout' || a === '--max-latency') {
      overrides.maxLatency = nextInt(i, a);
      i++;
      continue;
    }
    if (a === '--connect-timeout') {
      overrides.connectTimeout = nextInt(i, a);
      i++;
      continue;
    }
    if (a === '--ttfb-ratio') {
      overrides.ttfbRatio = nextInt(i, a);
      i++;
      continue;
    }
    if (a === '--max-gap') {
      overrides.maxGap = nextInt(i, a);
      i++;
      continue;
    }
    if (a === '--tls-host') {
      overrides.tlsHost = nextArg(i, a);
      i++;
      continue;
    }
    if (a === '--tls-port') {
      overrides.tlsPort = nextInt(i, a);
      i++;
      continue;
    }
    if (a === '--insecure' || a === '-i') {
      overrides.insecure = true;
      continue;
    }
    if (a === '--strict-tls' || a === '-s') {
      overrides.strictTLS = true;
      continue;
    }
    if (a === '--anon-check' || a === '-a') {
      overrides.anonCheck = true;
      continue;
    }
    if (a === '--throttle' || a === '-T') {
      overrides.throttle = nextInt(i, a);
      i++;
      continue;
    }
    if (!a.startsWith('-')) {
      proxyFile = a;
    }
  }

  if (!proxyFile) {
    logger.error({}, 'usage: validator <file> [--threads 20] [--mode quick|standard|strict|tcp-only|stream] [--json out.json]');
    throw new Error('usage: validator <file> [--threads 20] [--mode quick|standard|strict|tcp-only|stream] [--json out.json]');
  }

  // Base the CLI's option set on config.json (same file the server reads), then
  // apply any flags passed on the command line — mirrors the rest of the app's
  // "config file, then CLI flag" precedence instead of ignoring config.json outright.
  const opts: ValidatorOptions = buildOptionsFromConfig(loadConfig(), overrides);

  const onProgress: ProgressCallback = (res, _stats) => {
    if (res.valid) console.log(`[VALID] ${res.proxy}`);
    else console.log(`[INVALID] ${res.proxy} (${res.error})`);
  };

  const result = await validateFile(proxyFile, opts, onProgress);

  console.log(`\nTotal: ${result.valid.length} valid, ${result.invalid.length} invalid of ${result.total}`);

  if (output && result.valid.length) {
    fs.writeFileSync(output, `${result.valid.join('\n')}\n`);
    console.log(`Saved to ${output}`);
  }

  if (jsonOutput) {
    const reasons: Record<string, number> = {};
    for (const inv of result.invalid) {
      reasons[inv.reason] = (reasons[inv.reason] || 0) + 1;
    }
    const json = {
      total: result.total,
      valid: result.valid.length,
      invalid: result.invalid.length,
      validProxies: result.valid,
      invalidProxies: result.invalid.map((i) => ({ proxy: i.proxy, reason: i.reason })),
      reasons,
    };
    fs.writeFileSync(jsonOutput, JSON.stringify(json, null, 2));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cliMain().catch((e) => {
    logger.error({ error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, 'validator cli error');
    process.exit(1);
  });
}
