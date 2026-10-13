import net from 'node:net';
import { parseLine, unwrapProxyHost } from '../../proxy/dial.js';

export async function tcpCheck(host: string, port: number, timeoutMs: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, unwrapProxyHost(host));
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(to);
      try {
        sock.destroy();
      } catch {}
      reject(new Error('aborted'));
    };
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        abortSignal?.removeEventListener('abort', onAbort);
        sock.destroy();
        reject(new Error('TCP timeout'));
      }
    }, timeoutMs);
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      abortSignal?.removeEventListener('abort', onAbort);
      fn();
    };
    sock.on('connect', () => {
      settle(() => {
        sock.destroy();
        resolve();
      });
    });
    sock.on('error', (e) => {
      settle(() => reject(e));
    });
  });
}

export function parseProxyForTcp(proxyLine: string): { host: string; port: number } | null {
  const parsed = parseLine(proxyLine);
  if (!parsed) return null;
  // Default port must match dial(): http → 8080, socks → 1080. Port 80 here
  // would probe the wrong service for URLs without an explicit port.
  const port = parseInt(parsed.url.port, 10);
  const defaultPort = parsed.proto === 'socks' || parsed.proto === 'socks5' ? 1080 : 8080;
  return { host: unwrapProxyHost(parsed.url.hostname), port: !Number.isNaN(port) && port > 0 ? port : defaultPort };
}
