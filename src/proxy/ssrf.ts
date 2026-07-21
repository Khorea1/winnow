import dns from 'node:dns';
import net from 'node:net';
import { createLogger } from '../logger.js';

const logger = createLogger('ssrf');

// ── SSRF prevention ─────────────────────────────────────────────────────────
// Blocked ranges for proxy CONNECT/HTTP targets:
// IPv4: loopback 127/8, link-local 169.254/16, RFC 1918 (10/8, 172.16/12,
// 192.168/16), RFC 6598 CGNAT (100.64/10). Hostnames: localhost, *.local,
// *.internal. IPv6: loopback ::1, IPv4-mapped private ranges via ::ffff:.
// ULA (fc00::/7) is NOT blocked — internal networks legitimately use it.

function normalizeIPv6(host: string): string {
  // Only call after net.isIPv6(host) confirmed true
  const zoneIdx = host.indexOf('%');
  const cleanHost = zoneIdx !== -1 ? host.slice(0, zoneIdx) : host;
  const lower = cleanHost.toLowerCase();
  // Expand ::
  let groups: string[];
  if (lower.includes('::')) {
    const parts = lower.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    // Count right slots: a dot-containing group counts as 2 (IPv4 embedded)
    const rightSlotCount = right.reduce((sum, g) => sum + (g.includes('.') ? 2 : 1), 0);
    const missing = 8 - left.length - rightSlotCount;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = lower.split(':');
  }
  // Strip leading zeros from each hex group; preserve embedded IPv4 groups
  groups = groups.map((g) => (g.includes('.') ? g : g.replace(/^0+/g, '') || '0'));
  // Convert any embedded IPv4 dot-decimal group to two hex words
  const result: string[] = [];
  for (const g of groups) {
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
    if (ipv4Match) {
      const h1 = (parseInt(ipv4Match[1], 10) << 8) + parseInt(ipv4Match[2], 10);
      const h2 = (parseInt(ipv4Match[3], 10) << 8) + parseInt(ipv4Match[4], 10);
      result.push(h1.toString(16), h2.toString(16));
    } else {
      result.push(g);
    }
  }
  return result.join(':');
}

export function isBlockedTarget(host: string): boolean {
  // Strip IPv6 zone ID (e.g. fe80::1%eth0 → fe80::1)
  const zoneIdx = host.indexOf('%');
  const cleanHost = zoneIdx !== -1 ? host.slice(0, zoneIdx) : host;
  // Hostname-based blocking (SSRF prevention for internal hostnames)
  const lower = cleanHost.toLowerCase();
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower === '127.0.0.1' || lower === '::1' || lower === '0.0.0.0' || lower === '::')
    return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true;

  // IPv4 checks
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(cleanHost);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 127 || a === 0) return true; // loopback / 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local (incl. AWS IMDS)
    if (a === 10) return true; // RFC 1918 10/8
    if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 172.16/12
    if (a === 192 && b === 168) return true; // RFC 1918 192.168/16
  }
  // IPv6 checks
  if (net.isIPv6(cleanHost)) {
    const normalized = normalizeIPv6(cleanHost);
    // IPv6 loopback full form (both ::1 and zero-padded forms)
    if (normalized === '0:0:0:0:0:0:0:1') return true;

    // Handle all forms of embedded IPv4 addresses for SSRF prevention:
    // - IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4)
    // - Expanded forms (0:0:0:0:0:ffff:1.2.3.4)
    // - IPv4-compatible (::1.2.3.4)
    const v4Match = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4Match && net.isIPv4(v4Match[1])) {
      return isBlockedTarget(v4Match[1]);
    }

    // Hex-encoded IPv4-mapped IPv6 (::ffff:7f00:1 → 127.0.0.1)
    // This form doesn't contain dot-decimal so the regex above won't catch it.
    // After normalization, even expanded forms like 0:0:0:0:0:ffff:7f00:1
    // have the same prefix so they're caught here.
    const V4MAPPED_PREFIX = '0:0:0:0:0:ffff:';
    if (normalized.startsWith(V4MAPPED_PREFIX)) {
      const v4part = normalized.slice(V4MAPPED_PREFIX.length);
      // Dot-decimal: ::ffff:127.0.0.1
      if (net.isIPv4(v4part)) {
        return isBlockedTarget(v4part);
      }
      // Hex-encoded: ::ffff:7f00:1 → 127.0.0.1
      if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v4part)) {
        const [h1, h2] = v4part.split(':').map((h) => parseInt(h || '0', 16));
        const a = (h1 >> 8) & 0xff;
        const b = h1 & 0xff;
        const c = (h2 >> 8) & 0xff;
        const d = h2 & 0xff;
        return isBlockedTarget(`${a}.${b}.${c}.${d}`);
      }
    }
  }
  // Additional blocked hostnames for SSRF protection (pre-DNS)
  // Cloud metadata endpoints
  if (
    lower === 'metadata.google.internal' ||
    lower === 'metadata.internal' ||
    lower === '169.254.169.254' ||
    lower === '100.100.100.200' ||
    lower === 'instance-data' ||
    lower.startsWith('instance-data.')
  )
    return true;
  // Note: Post-DNS SSRF validation is handled in dial.ts via isBlockedAfterDns,
  // called before connecting through the upstream proxy. This pre-DNS check only
  // catches string-matching rules (literal IPs, known hostnames).
  return false;
}

export async function isBlockedAfterDns(host: string): Promise<boolean> {
  // Skip DNS resolution for bare IPs — already covered by isBlockedTarget
  if (net.isIPv4(host) || net.isIPv6(host)) return false;
  try {
    // Fast path: if the hostname is already blocked by string rules, block it
    if (isBlockedTarget(host)) return true;

    // Use 1-second timeout to avoid slow DNS on non-existent hostnames
    const lookupPromise = dns.promises.lookup(host, { all: true });
    const timeoutPromise = new Promise<dns.LookupAddress[]>((_, reject) => {
      setTimeout(() => reject(new Error('DNS lookup timed out')), 1000);
    });
    const addresses = await Promise.race([lookupPromise, timeoutPromise]);
    // dns.lookup returns either a single { address, family } or array thereof
    const entries = Array.isArray(addresses) ? addresses : [addresses];
    for (const entry of entries) {
      if (isBlockedTarget(entry.address)) return true;
    }
    return false;
  } catch {
    logger.warn({ host }, 'SSRF DNS check failed, allowing through (connection will fail at dial layer)');
    return false;
  }
}
