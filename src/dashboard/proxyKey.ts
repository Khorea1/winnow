import { createHmac, randomBytes } from 'node:crypto';

// IDs are process-local and cannot be used to guess embedded credentials.
// Distinct accounts at the same host must never share a dashboard deletion key.
const secret = randomBytes(32);

export function proxyId(raw: string): string {
  return `p_${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function sanitizeProxyKey(key: string): string {
  try {
    const u = new URL(key);
    u.username = '';
    u.password = '';
    // URL class adds trailing slash, remove it; also strip protocol prefix for consistent comparison
    return u
      .toString()
      .replace(/\/$/, '')
      .replace(/^[a-z]+:\/\//, '');
  } catch {
    // URL parsing failed — likely protocol-less string with credentials
    // Strip user:password@ prefix if present
    return key.replace(/^[^@]*@/, '');
  }
}
