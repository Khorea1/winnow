import type net from 'node:net';

// TTFB + idle timeout for single-socket upstream or bi-directional CONNECT.
export function startSocketTimeout(sockets: net.Socket[], ttfbMs: number, idleMs: number, onTimeout: () => void): () => void {
  let ttfbTimer: NodeJS.Timeout | null = setTimeout(() => {
    if (ttfbTimer === null) return;
    const t = idleTimer;
    ttfbTimer = null;
    idleTimer = null;
    if (t) clearTimeout(t);
    onTimeout();
  }, ttfbMs);
  let idleTimer: NodeJS.Timeout | null = null;

  function onData() {
    if (ttfbTimer) {
      clearTimeout(ttfbTimer);
      ttfbTimer = null;
      idleTimer = setTimeout(onTimeout, idleMs);
    } else if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onTimeout, idleMs);
    }
  }

  for (const s of sockets) s.on('data', onData);

  return function cancel() {
    if (ttfbTimer) {
      clearTimeout(ttfbTimer);
      ttfbTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const s of sockets) s.off('data', onData);
  };
}
