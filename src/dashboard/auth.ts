import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

function getAuthToken(): string | null {
  return process.env.WINNOW_TOKEN || process.env.DASHBOARD_TOKEN || process.env.API_TOKEN || null;
}

export function isAuthorized(req: IncomingMessage): boolean {
  const token = getAuthToken();
  if (!token) return true;
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return false;
  try {
    const bearerPrefix = 'Bearer ';
    const authValue = auth.startsWith(bearerPrefix) ? auth.slice(bearerPrefix.length) : auth;
    if (!authValue) return false;
    const provided = crypto.createHash('sha256').update(authValue).digest();
    const expected = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

export function isSafeProxyFile(filePath: string, allowedDir: string): boolean {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return false;
  const base = path.resolve(allowedDir);
  const resolved = path.resolve(filePath);
  return resolved === base || resolved.startsWith(base + path.sep);
}
