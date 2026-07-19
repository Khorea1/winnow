import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runValidation } from './runner.js';
import type { ValidatorOptions } from './types.js';

export interface CliOptions extends Partial<ValidatorOptions> {
  output?: string;
  jsonOutput?: string;
  verbose?: boolean;
}

interface ValidationConfigFragment {
  validationThreads?: number;
  validationMode?: 'quick' | 'standard' | 'strict' | 'stream';
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

export function buildOptionsFromConfig(config: ValidationConfigFragment, overrides: Partial<ValidatorOptions> = {}): ValidatorOptions {
  return {
    threads: overrides.threads ?? config.validationThreads ?? 20,
    mode: overrides.mode ?? config.validationMode ?? 'quick',
    baseUrl: overrides.baseUrl ?? config.validationBaseUrl ?? 'http://httpbin.org',
    connectTimeout: overrides.connectTimeout ?? config.validationConnectTimeout ?? 4,
    maxLatency: overrides.maxLatency ?? config.validationMaxLatency ?? 7000,
    ttfbRatio: overrides.ttfbRatio ?? config.validationTtfbRatio ?? 100,
    maxGap: overrides.maxGap ?? config.validationMaxGap ?? 0,
    insecure: overrides.insecure ?? config.validationInsecure ?? false,
    strictTLS: overrides.strictTLS ?? config.validationStrictTLS ?? false,
    anonCheck: overrides.anonCheck ?? config.validationAnonCheck ?? false,
    throttle: overrides.throttle ?? config.validationThrottle ?? 100,
    tlsHost: overrides.tlsHost ?? config.validationTlsHost ?? 'www.google.com',
    tlsPort: overrides.tlsPort ?? config.validationTlsPort ?? 443,
  };
}

export async function validateFile(filePath: string, opts: ValidatorOptions, onProgress?: any, abortSignal?: AbortSignal) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf8');
  const proxies = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('#'));
  // dedup
  const uniq = Array.from(new Set(proxies));

  const result = await runValidation(uniq, opts, onProgress, abortSignal);

  if (opts && (opts as any).output) {
    // output handled by caller
  }

  return {
    total: uniq.length,
    valid: result.valid,
    invalid: result.invalid,
    results: result.results,
  };
}

// CLI entry - compatible with legacy validador.sh
export async function cliMain() {
  const args = process.argv.slice(2);
  let proxyFile = '';
  let threads = 20;
  let mode: any = 'quick';
  let baseUrl = 'http://httpbin.org';
  let output = '';
  let jsonOutput = '';
  let insecure = false;
  let strictTLS = false;
  let anonCheck = false;
  let throttle = 100;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help' || a === '--ajuda') {
      console.log(`
Usage: validator [options] [<proxy-file>]

Options:
  -f, --file <path>         Proxy list file (default: from config)
  -t, --threads <n>         Concurrent validation threads (default: 20)
  -m, --mode <type>         Validation mode: quick|standard|strict|stream (default: quick)
  -b, --base-url <url>      Base URL for HTTP validation (default: http://httpbin.org)
  -o, --output <file>       Save valid proxies to file
  --json-output <file>      Save detailed JSON report
  -i, --insecure            Skip TLS certificate validation
  -s, --strict-tls          Enforce strict TLS validation
  -a, --anon-check          Check for transparent proxies (anonymity)
  -T, --throttle <n>       Jitter throttle in ms between probes (default: 100)
  -h, --help                Show this help message

Examples:
  node dist/validator/index.js proxies.txt
  node dist/validator/index.js proxies.txt --mode strict -o valid.txt
`);
      process.exit(0);
    }
    if (a === '-t' || a === '--threads') {
      threads = parseInt(args[++i], 10);
      continue;
    }
    if (a === '-o' || a === '--output') {
      output = args[++i];
      continue;
    }
    if (a === '--json-output') {
      jsonOutput = args[++i];
      continue;
    }
    if (a === '--mode') {
      mode = args[++i];
      continue;
    }
    if (a === '--base-url' || a === '-b') {
      baseUrl = args[++i];
      continue;
    }
    if (a === '--insecure' || a === '-i') {
      insecure = true;
      continue;
    }
    if (a === '--strict-tls' || a === '-s') {
      strictTLS = true;
      continue;
    }
    if (a === '--anon-check' || a === '-a') {
      anonCheck = true;
      continue;
    }
    if (a === '--throttle' || a === '-T') {
      throttle = parseInt(args[++i], 10);
      continue;
    }
    if (!a.startsWith('-')) {
      proxyFile = a;
    }
  }

  if (!proxyFile) {
    console.error('Usage: validator <file> [--threads 20] [--mode quick|standard|strict|stream] [--json-output out.json]');
    process.exit(1);
  }

  const opts: ValidatorOptions = {
    threads,
    mode,
    baseUrl,
    connectTimeout: 4,
    maxLatency: 7000,
    ttfbRatio: 100,
    maxGap: 0,
    insecure,
    strictTLS,
    anonCheck,
    throttle,
    tlsHost: 'www.google.com',
    tlsPort: 443,
  };

  const onProgress = (res: any, _stats: any) => {
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
    console.error(e);
    process.exit(1);
  });
}
