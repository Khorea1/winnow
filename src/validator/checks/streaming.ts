import type net from 'node:net';
import tls from 'node:tls';
import { dial, parseLine } from '../../proxy/dial.js';
import { isBlockedTarget } from '../../proxy/ssrf.js';

export interface StreamResult {
  chunks: number;
  ttfb: number;
  total: number;
  maxGap: number;
  status: number;
}

export async function streamingCheck(
  proxyRaw: string,
  targetUrl: string,
  opts: {
    connectTimeout: number;
    maxTime: number;
    ttfbRatio: number;
    maxGap: number;
    insecure: boolean;
    strictTLS: boolean;
  },
): Promise<StreamResult> {
  const parsedProxy = parseLine(proxyRaw);
  if (!parsedProxy) throw new Error('invalid format');

  const u = new URL(targetUrl);
  const tHost = u.hostname;
  if (isBlockedTarget(tHost)) {
    throw new Error(`target ${tHost} is blocked`);
  }

  const tPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  const pathAndQuery = u.pathname + u.search || '/';

  const { sock: rawSock } = await dial(parsedProxy, tHost, tPort, opts.connectTimeout * 1000);
  let sock: net.Socket | tls.TLSSocket = rawSock as net.Socket;
  if (u.protocol === 'https:') {
    sock = tls.connect({ socket: rawSock as net.Socket, servername: tHost, rejectUnauthorized: opts.strictTLS ? true : !opts.insecure });
    await new Promise<void>((resolve, reject) => {
      let tlsDone = false;
      const tlsTimer = setTimeout(() => {
        if (!tlsDone) {
          tlsDone = true;
          sock.destroy();
          reject(new Error('TLS handshake timeout'));
        }
      }, opts.connectTimeout * 1000);
      sock.once('secureConnect', () => {
        if (!tlsDone) {
          tlsDone = true;
          clearTimeout(tlsTimer);
          resolve();
        }
      });
      sock.once('error', (e) => {
        if (!tlsDone) {
          tlsDone = true;
          clearTimeout(tlsTimer);
          reject(e);
        }
      });
    });
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const start = Date.now();
    let firstByte = 0;
    let lastChunkTime = 0;
    let maxGap = 0;
    let chunks = 0;
    let status = 0;
    let headersEnd = -1;
    let headerBuf = '';

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          sock.destroy();
        } catch {}
        reject(new Error('stream timeout'));
      }
    }, opts.maxTime * 1000);

    sock.on('data', (d: Buffer) => {
      if (done) return;
      const now = Date.now();
      if (firstByte === 0) firstByte = now;
      if (headersEnd === -1) {
        headerBuf += d.toString('utf8', 0, Math.min(d.length, 65536 - headerBuf.length));
        if (headerBuf.length > 65536) {
          done = true;
          clearTimeout(timer);
          reject(new Error('response headers too large'));
          return;
        }
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          const firstLine = headerBuf.slice(0, idx).split('\r\n')[0] || '';
          status = parseInt(firstLine.split(' ')[1] || '0', 10);
          let bodyPart = headerBuf.slice(idx + 4);

          while (status === 100 && bodyPart.indexOf('\r\n\r\n') !== -1) {
            const nextIdx = bodyPart.indexOf('\r\n\r\n');
            const nextHeader = bodyPart.slice(0, nextIdx);
            const nextFirstLine = nextHeader.split('\r\n')[0] || '';
            status = parseInt(nextFirstLine.split(' ')[1] || '0', 10);
            bodyPart = bodyPart.slice(nextIdx + 4);
          }

          if (status === 100 && bodyPart.indexOf('\r\n\r\n') === -1) {
            headerBuf = bodyPart;
            return;
          }

          headersEnd = 1;
          if (bodyPart.trim()) {
            chunks++;
            lastChunkTime = now;
          }
        }
      } else {
        chunks++;
        const gap = lastChunkTime ? now - lastChunkTime : 0;
        if (gap > maxGap) maxGap = gap;
        lastChunkTime = now;
      }
    });

    sock.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // If headers never completed, the connection closed before we got a full response
      if (headersEnd === -1) {
        reject(new Error('no HTTP response headers received'));
        return;
      }
      const total = Date.now() - start;
      const ttfb = firstByte ? firstByte - start : total;

      if (status !== 200) {
        try {
          sock.destroy();
        } catch {}
        reject(new Error(`HTTP ${status}`));
        return;
      }

      // TTFB ratio check
      if (opts.ttfbRatio < 100 && total > 0 && ttfb > 0) {
        const ratio = (ttfb * 100) / total;
        if (ratio > opts.ttfbRatio) {
          try {
            sock.destroy();
          } catch {}
          reject(new Error(`buffering ttfb ratio ${ratio.toFixed(0)}% > ${opts.ttfbRatio}%`));
          return;
        }
      }

      if (opts.maxGap > 0 && maxGap > opts.maxGap) {
        try {
          sock.destroy();
        } catch {}
        reject(new Error(`gap ${maxGap}ms > ${opts.maxGap}ms`));
        return;
      }

      try {
        sock.destroy();
      } catch {}
      resolve({ chunks, ttfb, total, maxGap, status: status || 200 });
    });

    sock.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        try {
          sock.destroy();
        } catch {}
        reject(e);
      }
    });

    const req = `GET ${pathAndQuery} HTTP/1.1\r\nHost: ${tHost}\r\nConnection: close\r\nUser-Agent: winnow/4.0\r\nAccept: */*\r\n\r\n`;
    try {
      sock.write(req);
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        try {
          sock.destroy();
        } catch {}
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  });
}
