import { createHmac, randomBytes } from 'node:crypto';

// Opaque, process-local identity: two upstreams that differ only in credentials
// must never share a dashboard deletion key. The secret prevents offline guesses
// of credentials from IDs published by /__stats.
const secret = randomBytes(32);

export function proxyId(raw: string): string {
  return `p_${createHmac('sha256', secret).update(raw).digest('hex')}`;
}
