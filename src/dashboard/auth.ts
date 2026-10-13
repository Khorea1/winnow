import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

export function getAuthToken() {
  return process.env.WINNOW_TOKEN || process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || null;
}
export function isAuthorized(req: IncomingMessage): boolean {
  const token = getAuthToken();
  if (!token) return true; // No auth configured — allow all
  const auth = req.headers.authorization;
  if (!auth) return false;
  try {
    // Support both "Bearer <token>" and raw token
    if (typeof auth === 'string') {
      // Compare lengths to avoid timingSafeEqual throw
      const bearerPrefix = 'Bearer ';
      const authValue = auth.startsWith(bearerPrefix) ? auth.slice(bearerPrefix.length) : auth;
      const tokenBuf = Buffer.from(token);
      const authBuf = Buffer.from(authValue);
      // Pad to same length to avoid timingSafeEqual throw on length mismatch
      const maxLen = Math.max(tokenBuf.length, authBuf.length);
      if (maxLen === 0) return false;
      return crypto.timingSafeEqual(
        Buffer.concat([tokenBuf, Buffer.alloc(maxLen - tokenBuf.length)]),
        Buffer.concat([authBuf, Buffer.alloc(maxLen - authBuf.length)]),
      );
    }
  } catch {
    return false;
  }
  return false;
}
export function isSafeProxyFile(p: string, allowedDir: string): boolean {
  try {
    const resolved = fs.realpathSync(p);
    if (resolved.startsWith(allowedDir + path.sep) || resolved === allowedDir) return true;
    if (path.isAbsolute(p)) {
      const normalized = path.normalize(p);
      if (normalized.includes('..')) return false;
      return fs.existsSync(normalized);
    }
    return false;
  } catch {
    return false;
  }
}
