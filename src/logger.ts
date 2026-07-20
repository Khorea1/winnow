export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_MAP: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let _minLevel: number | null = null;

function resolveMinLevel(): number {
  if (_minLevel !== null) return _minLevel;
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  _minLevel = LEVEL_MAP[env] ?? LEVEL_MAP.info;
  return _minLevel;
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

export interface Logger {
  debug(ctx: Record<string, unknown>, msg: string): void;
  info(ctx: Record<string, unknown>, msg: string): void;
  warn(ctx: Record<string, unknown>, msg: string): void;
  error(ctx: Record<string, unknown>, msg: string): void;
}

export function createLogger(name: string): Logger {
  const minLevel = resolveMinLevel();

  function log(level: LogLevel, ctx: Record<string, unknown>, msg: string): void {
    if (LEVEL_MAP[level] < minLevel) return;
    const entry: Record<string, unknown> = {
      time: formatTime(new Date()),
      level: level.toUpperCase(),
      name,
      msg,
    };
    for (const [k, v] of Object.entries(ctx)) {
      // Avoid collisions with built-in fields
      if (k === 'time' || k === 'level' || k === 'name' || k === 'msg') continue;
      entry[k] = v;
    }
    try {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Swallow write errors silently — we're already logging a failure
    }
  }

  return {
    debug: (ctx, msg) => log('debug', ctx, msg),
    info: (ctx, msg) => log('info', ctx, msg),
    warn: (ctx, msg) => log('warn', ctx, msg),
    error: (ctx, msg) => log('error', ctx, msg),
  };
}
