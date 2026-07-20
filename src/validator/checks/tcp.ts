import net from 'node:net';

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
  let line = proxyLine.trim();
  if (!line) return null;
  if (!line.includes('://')) line = `http://${line}`;
  try {
    const u = new URL(line);
    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!host || (u.port && !port)) return null;
    return { host, port: port || 80 };
  } catch {
    return null;
  }
}
