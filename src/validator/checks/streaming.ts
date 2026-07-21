import { dial, parseLine } from '../../proxy/dial.js';

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
    expectedChunks: number;
    ttfbRatio: number;
    maxGap: number;
  },
): Promise<StreamResult> {
  const parsedProxy = parseLine(proxyRaw);
  if (!parsedProxy) throw new Error('invalid format');

  const u = new URL(targetUrl);
  const tHost = u.hostname;
  const tPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  const pathAndQuery = u.pathname + u.search || '/';

  const { sock } = await dial(parsedProxy, tHost, tPort, opts.connectTimeout * 1000);

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
      const now = Date.now();
      if (firstByte === 0) firstByte = now;
      if (headersEnd === -1) {
        headerBuf += d.toString();
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
        const str = d.toString();
        // Count non-empty lines as chunks (httpbin stream returns json per line)
        const lines = str.split('\n').filter((l) => l.trim().length > 10);
        if (lines.length) {
          const gap = lastChunkTime ? now - lastChunkTime : 0;
          if (gap > maxGap) maxGap = gap;
          chunks += lines.length;
          lastChunkTime = now;
        } else if (str.trim()) {
          chunks++;
        }
      }
    });

    sock.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const total = Date.now() - start;
      const ttfb = firstByte ? firstByte - start : total;

      if (status !== 0 && status !== 200) {
        reject(new Error(`HTTP ${status}`));
        return;
      }

      // TTFB ratio check
      if (opts.ttfbRatio < 100 && total > 0 && ttfb > 0) {
        const ratio = (ttfb * 100) / total;
        if (ratio > opts.ttfbRatio) {
          reject(new Error(`buffering ttfb ratio ${ratio.toFixed(0)}% > ${opts.ttfbRatio}%`));
          return;
        }
      }

      if (opts.maxGap > 0 && maxGap > opts.maxGap) {
        reject(new Error(`gap ${maxGap}ms > ${opts.maxGap}ms`));
        return;
      }

      resolve({ chunks, ttfb, total, maxGap, status: status || 200 });
    });

    sock.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });

    const req = `GET ${pathAndQuery} HTTP/1.1\r\nHost: ${tHost}\r\nConnection: close\r\nUser-Agent: winnow/4.0\r\nAccept: */*\r\n\r\n`;
    sock.write(req);
  });
}
