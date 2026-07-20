import type net from 'node:net';
import tls from 'node:tls';
import { dial, parseLine } from '../../proxy/dial.js';

export interface HttpCheckResult {
  latency: number;
  ttfb: number;
  status: number;
  body: string;
  headers: string;
}

export async function httpCheck(
  proxyRaw: string,
  targetUrl: string,
  opts: {
    connectTimeout: number;
    maxLatency: number;
    insecure: boolean;
    strictTLS: boolean;
    anonCheck: boolean;
  },
): Promise<HttpCheckResult> {
  const parsedProxy = parseLine(proxyRaw);
  if (!parsedProxy) throw new Error('invalid format');

  const u = new URL(targetUrl);
  const tHost = u.hostname;
  const tPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  const isHttps = u.protocol === 'https:';
  const pathAndQuery = u.pathname + u.search || '/';

  const start = Date.now();
  let ttfb = 0;

  // Dial via proxy
  const { sock } = await dial(parsedProxy, tHost, tPort, opts.connectTimeout * 1000);

  let socket: net.Socket | tls.TLSSocket = sock as net.Socket;

  // If target is HTTPS, wrap the connection in TLS once (single TLSSocket, no pre-check)
  if (isHttps) {
    let tlsDone = false;
    const tlsSocket: tls.TLSSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const ts = tls.connect(
        {
          socket: sock,
          servername: tHost,
          rejectUnauthorized: opts.strictTLS,
        } satisfies tls.ConnectionOptions,
        () => {
          if (tlsDone) return;
          tlsDone = true;
          clearTimeout(tlsTo);
          resolve(ts);
        },
      );
      ts.on('error', (err) => {
        if (tlsDone) return;
        tlsDone = true;
        clearTimeout(tlsTo);
        try {
          sock.destroy();
        } catch {}
        reject(err);
      });
      const tlsTo = setTimeout(() => {
        if (tlsDone) return;
        tlsDone = true;
        try {
          sock.destroy();
        } catch {}
        reject(new Error('TLS timeout'));
      }, opts.connectTimeout * 1000);
    });
    socket = tlsSocket;
  }

  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headersEnd = -1;
    let firstByteTime = 0;
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          socket.destroy();
        } catch {}
        reject(new Error('HTTP timeout'));
      }
    }, opts.maxLatency + 5000);

    const onData = (chunk: Buffer) => {
      if (firstByteTime === 0) {
        firstByteTime = Date.now();
        ttfb = firstByteTime - start;
      }
      buf = Buffer.concat([buf, chunk]);
      if (headersEnd === -1) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          headersEnd = idx;
        }
      }
      // If we already have headers and full body? For /ip, body is small, we can wait for close
      // But we'll wait for socket end to keep it simple
    };

    socket.on('data', onData);
    socket.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      const totalLatency = Date.now() - start;
      const full = buf.toString();
      const headerEndIdx = full.indexOf('\r\n\r\n');
      let headerStr = '';
      let bodyStr = '';
      let status = 0;
      if (headerEndIdx !== -1) {
        headerStr = full.slice(0, headerEndIdx);
        bodyStr = full.slice(headerEndIdx + 4);
        const firstLine = headerStr.split('\r\n')[0] || '';
        status = parseInt(firstLine.split(' ')[1] || '0', 10);
      } else {
        bodyStr = full;
      }

      // Anon check
      if (opts.anonCheck && status === 200) {
        const lower = (headerStr + bodyStr).toLowerCase();
        if (lower.includes('x-forwarded-for') || lower.includes('via:') || bodyStr.includes('"X-Forwarded-For"')) {
          try {
            socket.destroy();
          } catch {}
          reject(new Error('proxy transparent'));
          return;
        }
      }

      try {
        socket.destroy();
      } catch {}
      resolve({ latency: totalLatency, ttfb, status, body: bodyStr, headers: headerStr });
    });

    socket.on('error', (e: Error) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        try {
          socket.destroy();
        } catch {}
        reject(e);
      }
    });

    // Envia request
    const reqStr = `GET ${pathAndQuery} HTTP/1.1\r\nHost: ${tHost}\r\nConnection: close\r\nUser-Agent: winnow/4.0\r\nAccept: */*\r\n\r\n`;
    try {
      socket.write(reqStr);
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        reject(e);
      }
    }
  });
}
