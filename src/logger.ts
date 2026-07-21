export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_MAP: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
function resolveMinLevel(): number {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  return LEVEL_MAP[env] ?? LEVEL_MAP.info;
}

function formatTime(d: Date): string {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}`;
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
      if (k === 'time' || k === 'level' || k === 'name' || k === 'msg' || k === '_jsonError' || k === '_circular') continue;
      entry[k] = v;
    }
    let jsonStr = '';
    let jsonError: string | undefined;
    try {
      jsonStr = JSON.stringify(entry);
    } catch (e) {
      jsonError = e instanceof Error ? e.message : String(e);
    }
    if (jsonError) {
      try {
        jsonStr = JSON.stringify({
          time: entry.time,
          level: entry.level,
          name: entry.name,
          msg: entry.msg,
          _jsonError: jsonError,
          _circular: true,
        });
      } catch {
        jsonStr = JSON.stringify({
          time: entry.time || new Date().toISOString(),
          level: entry.level || 'ERROR',
          name: entry.name || 'logger',
          msg: entry.msg || 'logging error',
          _jsonError: jsonError,
          _circular: true,
        });
      }
    }
    try {
      process.stderr.write(`${jsonStr}\n`);
    } catch {
      // Swallow write errors
    }
  }

  return {
    debug: (ctx, msg) => log('debug', ctx, msg),
    info: (ctx, msg) => log('info', ctx, msg),
    warn: (ctx, msg) => log('warn', ctx, msg),
    error: (ctx, msg) => log('error', ctx, msg),
  };
}
