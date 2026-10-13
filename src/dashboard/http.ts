import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../logger.js';

const MAX_BODY_SIZE = 32 * 1024;
const logger = createLogger('dashboard');

export function respondJson(res: ServerResponse, data: unknown, status = 200): void {
  try {
    if (res.headersSent) {
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch {}
}

export function sanitizeError(_error: unknown): string {
  return 'Internal server error';
}

export function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  let resolved = false;
  req.on('data', (chunk: Buffer) => {
    if (tooLarge) return;
    chunks.push(chunk);
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      tooLarge = true;
      try {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Body too large - max ${MAX_BODY_SIZE}` }));
      } catch {}
      chunks.length = 0;
      req.resume();
      resolved = true;
      resolve(null);
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    const body = Buffer.concat(chunks).toString('utf8');
    resolved = true;
    resolve(body);
    chunks.length = 0;
  });
  req.on('error', (error) => {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'readBody request error');
    resolve(null);
  });
  req.on('close', () => {
    if (!resolved) {
      logger.warn({}, 'readBody premature close');
      resolve(null);
    }
  });
  return promise;
}
