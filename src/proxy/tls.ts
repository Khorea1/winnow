import type net from 'node:net';
import tls from 'node:tls';

export interface TlsResult {
  authorized: boolean;
  authorizationError?: string;
  cert?: any;
  protocol?: string;
}

export function tlsHandshake(sock: net.Socket, host: string, opts: { insecure?: boolean; timeout?: number } = {}): Promise<TlsResult> {
  const timeout = opts.timeout ?? 5000;
  const insecure = opts.insecure ?? false;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          sock.destroy();
        } catch {}
        reject(new Error('TLS handshake timeout'));
      }
    }, timeout);

    try {
      const tlsSock = tls.connect(
        {
          socket: sock,
          servername: host,
          rejectUnauthorized: !insecure,
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const authorized = tlsSock.authorized;
          const authError = tlsSock.authorizationError;
          const cert = tlsSock.getPeerCertificate();
          const protocol = tlsSock.getProtocol() || undefined;
          try {
            tlsSock.end();
          } catch {}
          resolve({ authorized, authorizationError: authError?.message, cert, protocol });
        },
      );
      tlsSock.on('error', (e: Error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          if (insecure) {
            // Lenient mode: don't reject on TLS errors, just report as unauthorized
            resolve({ authorized: false, authorizationError: e.message, cert: null });
          } else {
            reject(e);
          }
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

export function isSelfSignedError(result: TlsResult): boolean {
  const msg = (result.authorizationError || '').toLowerCase();
  return (
    !result.authorized &&
    (msg.includes('self signed') ||
      msg.includes('self-signed') ||
      msg.includes('unable to verify') ||
      msg.includes('unable to get local issuer') ||
      msg.includes('certificate has expired') ||
      msg.includes('depth_zero_self_signed'))
  );
}
