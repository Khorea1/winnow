import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../logger.js';

const logger = createLogger('dashboard');
const MAX_BODY_SIZE = 32 * 1024;

export function respondJson(res: ServerResponse, data: unknown, status = 200) {
  try {
    if (res.headersSent) {
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch {}
}

export function sanitizeError(_e: unknown): string {
  return 'Internal server error';
}

/** Read request body with size limit. Returns null and sends 413 if too large. */
export function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  let _resolved = false;
  req.on('data', (c: Buffer) => {
    if (tooLarge) return;
    chunks.push(c);
    totalBytes += c.length;
    if (totalBytes > MAX_BODY_SIZE) {
      tooLarge = true;
      try {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Body too large - max ${MAX_BODY_SIZE}` }));
      } catch {}
      chunks.length = 0; // free chunk references immediately
      req.resume();
      _resolved = true;
      resolve(null); // Resolve immediately to prevent dangling promises
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    const body = Buffer.concat(chunks).toString('utf8');
    _resolved = true;
    resolve(body);
    chunks.length = 0; // free memory after consuming body
  });
  // Prevent hanging promise if the client disconnects mid-request
  req.on('error', (e) => {
    logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'readBody request error');
    resolve(null);
  });
  req.on('close', () => {
    if (!_resolved) {
      logger.warn({}, 'readBody premature close');
      resolve(null);
    }
  });
  return promise;
}
