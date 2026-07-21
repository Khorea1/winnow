import net from 'node:net';
import { parseLine } from '../../proxy/dial.js';

export async function tcpCheck(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let done = false;
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error('TCP timeout'));
      }
    }, timeoutMs);
    sock.on('connect', () => {
      if (!done) {
        done = true;
        clearTimeout(to);
        sock.destroy();
        resolve();
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

export function parseProxyForTcp(proxyLine: string): { host: string; port: number } | null {
  const parsed = parseLine(proxyLine);
  if (!parsed) return null;
  const port = parseInt(parsed.url.port, 10) || (parsed.url.protocol === 'https:' ? 443 : 80);
  return { host: parsed.url.hostname, port };
}
