import net from 'node:net';
import { isBlockedTarget, resolveTargetAddress } from './ssrf.js';

export interface ParsedProxy {
  raw: string;
  url: URL;
  proto: string;
}

export function parseLine(line: string): ParsedProxy | null {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  const original = line;
  if (!line.includes('://')) line = `http://${line}`;
  try {
    const u = new URL(line);
    if (!['http:', 'https:', 'socks5:', 'socks:'].includes(u.protocol)) return null;
    if (u.protocol === 'https:') {
      // https:// proxy URLs require TLS to the proxy itself — not supported
      return null;
    }
    return { raw: original, url: u, proto: u.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

export function parseUniqueProxies(content: string): ParsedProxy[] {
  const seen = new Set<string>();
  const proxies: ParsedProxy[] = [];
  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (parsed && !seen.has(parsed.url.href)) {
      seen.add(parsed.url.href);
      proxies.push(parsed);
    }
  }
  return proxies;
}

export function parseHostPort(input: string, defaultPort = 443): { host: string; port: number } | null {
  if (!input) return null;
  input = input.trim();
  if (!input) return null;
  if (input.startsWith('[')) {
    const closeIdx = input.indexOf(']');
    if (closeIdx === -1) return null;
    const host = input.slice(1, closeIdx);
    const rest = input.slice(closeIdx + 1);
    if (!rest) return { host, port: defaultPort };
    if (rest.startsWith(':')) {
      const port = parseInt(rest.slice(1), 10);
      return { host, port: Number.isFinite(port) ? port : defaultPort };
    }
    if (rest && !rest.startsWith(':')) return null;
    return { host, port: defaultPort };
  }
  // Bare IPv6 literal without brackets (e.g. `::1`). Must check before
  // last-colon logic below, which would split on the colon inside the address.
  // Also handle `::1:8080` — IPv6 with a port suffix but no brackets.
  if (input.includes('::')) {
    const lastColon = input.lastIndexOf(':');
    const portStr = input.slice(lastColon + 1);
    if (/^\d+$/.test(portStr) && lastColon > 1) {
      const host = input.slice(0, lastColon);
      // If host ends with ':', this is a bare IPv6 address, not host:port
      if (host.endsWith(':')) {
        return { host: input, port: defaultPort };
      }
      const port = parseInt(portStr, 10);
      return { host, port: Number.isFinite(port) ? port : defaultPort };
    }
    return { host: input, port: defaultPort };
  }
  const lastColon = input.lastIndexOf(':');
  if (lastColon === -1) return { host: input, port: defaultPort };
  const host = input.slice(0, lastColon);
  const portStr = input.slice(lastColon + 1);
  if (host.includes(':') && !/^\d+$/.test(portStr)) {
    return { host: input, port: defaultPort };
  }
  const port = parseInt(portStr, 10);
  if (Number.isFinite(port) && port > 0 && port <= 65535) {
    return { host, port };
  }
  return { host, port: defaultPort };
}

// WHATWG URL keeps brackets in `hostname` for IPv6 literals (`[::1]`).
// `net.connect(port, '[::1]')` never connects nor errors — it hangs until
// timeout. Strip brackets before dialing.
export function unwrapProxyHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

// CONNECT handshake uses `timeout` ms (typically 3500). After success the
// caller's data timeout applies — no separate phase needed.
export function httpConnect(upstream: ParsedProxy, tHost: string, tPort: number, timeout: number): Promise<{ sock: net.Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = upstream.url;
    const portNum = parseInt(u.port, 10);
    const pp = !Number.isNaN(portNum) && portNum > 0 ? portNum : 8080;
    const user = u.username;
    // Uses string concatenation instead of a nested template literal, which broke tsc.
    let auth = '';
    if (user) {
      const token = Buffer.from(`${user}:${u.password}`).toString('base64');
      auth = `Proxy-Authorization: Basic ${token}\r\n`;
    }
    const proxyHost = unwrapProxyHost(u.hostname);
    const sock = net.connect(pp, proxyHost);
    let done = false;
    let buf = Buffer.alloc(0);
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error('timeout http'));
      }
    }, timeout);
    sock.on('connect', async () => {
      if (tHost.includes('\r') || tHost.includes('\n') || tHost.includes('\x00')) {
        done = true;
        clearTimeout(to);
        sock.destroy();
        reject(new Error('invalid target host'));
        return;
      }
      const authority = net.isIPv6(tHost) ? `[${tHost}]:${tPort}` : `${tHost}:${tPort}`;
      const req = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}Connection: keep-alive\r\n\r\n`;
      sock.write(req);
    });
    sock.on('data', (d: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (buf.length > 32768) {
        done = true;
        clearTimeout(to);
        sock.destroy();
        reject(new Error('upstream response header too large'));
        return;
      }
      // Loop to handle 1xx interim responses (e.g., 100 Continue)
      while (true) {
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const headStr = buf.slice(0, headEnd).toString();
        const firstLine = headStr.split('\r\n')[0] || '';
        const parts = firstLine.split(' ');
        const code = parseInt(parts[1] ?? '', 10);
        if (!Number.isFinite(code)) {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error(`proxy bad status line ${firstLine}`));
          return;
        }
        if (code === 200) {
          done = true;
          clearTimeout(to);
          resolve({ sock, head: buf.slice(headEnd + 4) });
          return;
        }
        if (code >= 100 && code < 200) {
          // Interim 1xx response (e.g., 100 Continue) — consume and continue
          buf = buf.slice(headEnd + 4);
          continue;
        }
        // >=400, 0, or other non-success code
        done = true;
        clearTimeout(to);
        sock.destroy();
        if (code >= 400 || code === 0) {
          reject(new Error(`proxy refused ${firstLine}`));
        } else {
          reject(new Error(`proxy responded with ${code}`));
        }
        return;
      }
    });
    sock.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(to);
        reject(e);
      }
    });
    sock.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(to);
        reject(new Error('closed before 200'));
      }
    });
  });
}

function socks5AddrBuffer(tHost: string, tPort: number): Buffer {
  const pb = Buffer.alloc(2);
  pb.writeUInt16BE(tPort, 0);
  if (net.isIPv4(tHost)) {
    const parts = tHost.split('.').map(Number);
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts]), pb]);
  }
  if (net.isIPv6(tHost)) {
    // Expand :: and convert to 16 raw bytes
    const parts = tHost.split(':');
    const gapIdx = parts.indexOf('');
    const before = gapIdx === -1 ? parts : parts.slice(0, gapIdx);
    const after = gapIdx === -1 ? [] : parts.slice(gapIdx + 1).filter((s) => s !== '');
    // Count IPv4 dot-decimal segments as 2 slots each
    const afterSlotCount = after.reduce((sum, seg) => sum + (seg.includes('.') ? 2 : 1), 0);
    const beforeSlotCount = before.reduce((sum, seg) => sum + (seg.includes('.') ? 2 : 1), 0);
    const zerosNeeded = 8 - beforeSlotCount - afterSlotCount;
    const bytes: number[] = [];
    for (const seg of before) {
      const cleanSeg = seg.split('%')[0] ?? '';
      if (cleanSeg.includes('.')) {
        const octets = cleanSeg.split('.').map(Number);
        bytes.push(...octets);
      } else {
        const n = parseInt(cleanSeg || '0', 16);
        bytes.push((n >> 8) & 0xff, n & 0xff);
      }
    }
    for (let i = 0; i < zerosNeeded; i++) bytes.push(0, 0);
    for (const seg of after) {
      const cleanSeg = seg.split('%')[0] ?? '';
      if (cleanSeg.includes('.')) {
        const octets = cleanSeg.split('.').map(Number);
        bytes.push(...octets);
      } else {
        const n = parseInt(cleanSeg || '0', 16);
        bytes.push((n >> 8) & 0xff, n & 0xff);
      }
    }
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04, ...bytes]), pb]);
  }
  // Domain name (existing behavior)
  const hb = Buffer.from(tHost);
  if (hb.length > 255) {
    throw new Error('SOCKS5 target hostname too long');
  }
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, pb]);
}

// CONNECT handshake uses `timeout` ms (typically 3500). After success the
// caller's data timeout applies — no separate phase needed.
export function socks5Connect(upstream: ParsedProxy, tHost: string, tPort: number, timeout: number): Promise<{ sock: net.Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = upstream.url;
    const portNum = parseInt(u.port, 10);
    const pp = !Number.isNaN(portNum) && portNum > 0 ? portNum : 1080;
    const proxyHost = unwrapProxyHost(u.hostname);
    const sock = net.connect(pp, proxyHost);
    let done = false;
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error('timeout socks5'));
      }
    }, timeout);
    let stage = 0;
    sock.on('connect', () => {
      if (u.username) sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      else sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let replyBuf = Buffer.alloc(0);
    sock.on('data', (data: Buffer) => {
      if (done) return;
      if (stage === 0) {
        // Validate SOCKS5 version byte — reject non-SOCKS5 responses
        if (data.length < 2 || data[0] !== 0x05) {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error('socks5 invalid version'));
          return;
        }
        if (data[1] === 0x02) {
          const user = u.username;
          const pass = u.password;
          const ub = Buffer.from(user);
          const pb = Buffer.from(pass);
          if (ub.length > 255 || pb.length > 255) {
            done = true;
            clearTimeout(to);
            sock.destroy();
            reject(new Error('socks5 auth too long'));
            return;
          }
          const b = Buffer.alloc(3 + ub.length + pb.length);
          b[0] = 0x01;
          b[1] = ub.length;
          ub.copy(b, 2);
          b[2 + ub.length] = pb.length;
          pb.copy(b, 3 + ub.length);
          sock.write(b);
          stage = 1;
          return;
        }
        if (data[1] !== 0x00) {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error('socks5 no auth'));
          return;
        }
        sock.write(socks5AddrBuffer(tHost, tPort));
        stage = 2;
      } else if (stage === 1) {
        if (data.length < 2) return;
        if (data[1] !== 0x00) {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error('socks5 auth fail'));
          return;
        }
        sock.write(socks5AddrBuffer(tHost, tPort));
        stage = 2;
      } else {
        if (replyBuf.length + data.length > 65536) {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error('SOCKS5 reply too large'));
          return;
        }
        replyBuf = Buffer.concat([replyBuf, data]);
        if (replyBuf.length < 4) return; // need ATYP byte
        if (replyBuf[0] !== 0x05) {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error('SOCKS5 invalid version'));
          return;
        }
        // Determine minimum reply length based on ATYP
        const atyp = replyBuf[3];
        let minLen: number;
        if (atyp === 0x01) {
          minLen = 10; // 4 + IPv4(4) + port(2)
        } else if (atyp === 0x03) {
          if (replyBuf.length < 5) return; // need domain length byte
          minLen = 7 + replyBuf[4]!; // 4 + 1(domlen) + domLen + 2(port)
        } else if (atyp === 0x04) {
          minLen = 22; // 4 + IPv6(16) + port(2)
        } else {
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(new Error(`SOCKS5 unsupported ATYP ${atyp}`));
          return;
        }
        if (replyBuf.length < minLen) return;
        if (replyBuf[1] !== 0x00) {
          const SOCKS_REPLY_CODES: Record<number, string> = {
            0: 'succeeded',
            1: 'general SOCKS server failure',
            2: 'connection not allowed by ruleset',
            3: 'Network unreachable',
            4: 'Host unreachable',
            5: 'Connection refused',
            6: 'TTL expired',
            7: 'Command not supported',
            8: 'Address type not supported',
          };
          const codeDesc = SOCKS_REPLY_CODES[replyBuf[1]!] || 'unknown';
          const err = new Error(`socks5 connect fail ${replyBuf[1]} (${codeDesc})`);
          Object.defineProperty(err, 'socksReply', { value: replyBuf[1] });
          done = true;
          clearTimeout(to);
          sock.destroy();
          reject(err);
          return;
        }
        done = true;
        clearTimeout(to);
        resolve({ sock, head: Buffer.alloc(0) });
      }
    });
    sock.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(to);
        reject(e);
      }
    });
    sock.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(to);
        reject(new Error('closed before SOCKS5 reply'));
      }
    });
  });
}

export type DialMode = 'tunnel' | 'forward';

/** True when dial() will skip the CONNECT handshake for this upstream+mode. */
export function isForwardedDial(upstream: ParsedProxy, mode: DialMode): boolean {
  return mode === 'forward' && upstream.proto !== 'socks5' && upstream.proto !== 'socks';
}

// Plain-HTTP forwarding: open a raw TCP connection to the upstream proxy
// without a CONNECT handshake. The caller sends an absolute-URI request line
// (`GET http://host/path`). Used for plain-http targets — some public HTTP
// proxies refuse CONNECT on port 80.
export function httpForwardProxy(upstream: ParsedProxy, timeout: number): Promise<{ sock: net.Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = upstream.url;
    const portNum = parseInt(u.port, 10);
    const pp = !Number.isNaN(portNum) && portNum > 0 ? portNum : 8080;
    const sock = net.connect(pp, unwrapProxyHost(u.hostname));
    let done = false;
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error('timeout forward'));
      }
    }, timeout);
    sock.on('connect', () => {
      if (!done) {
        done = true;
        clearTimeout(to);
        resolve({ sock, head: Buffer.alloc(0) });
      }
    });
    sock.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(to);
        reject(e);
      }
    });
  });
}

export async function dial(upstream: ParsedProxy, h: string, p: number, timeout: number, mode: DialMode = 'tunnel', pinnedAddress?: string) {
  if (!['http', 'socks5', 'socks'].includes(upstream.proto)) {
    throw new Error(`unsupported proxy protocol: ${upstream.proto}`);
  }
  if (isBlockedTarget(h) || (pinnedAddress && (!net.isIP(pinnedAddress) || isBlockedTarget(pinnedAddress)))) {
    throw new Error(`target blocked by SSRF rules: ${h}`);
  }
  const address = pinnedAddress ?? (await resolveTargetAddress(h));
  if (upstream.proto === 'socks5' || upstream.proto === 'socks') return socks5Connect(upstream, address, p, timeout);
  if (upstream.proto === 'socks4' || upstream.proto === 'socks4a') throw new Error('SOCKS4 not supported');
  if (isForwardedDial(upstream, mode)) return httpForwardProxy(upstream, timeout);
  return httpConnect(upstream, address, p, timeout);
}
