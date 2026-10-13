import { dial, parseLine } from '../../proxy/dial.js';
import { isSoftTlsError, tlsHandshake } from '../../proxy/tls.js';
import type { Timeouts } from '../types.js';

export interface TlsCheckResult {
  authorized: boolean;
  error?: string;
  selfSigned: boolean;
  protocol?: string;
}

export async function tlsCheck(
  proxyRaw: string,
  targetHost: string,
  targetPort: number,
  opts: {
    timeouts: Timeouts;
    insecure: boolean;
    strictTLS: boolean;
  },
): Promise<TlsCheckResult> {
  const parsedProxy = parseLine(proxyRaw);
  if (!parsedProxy) throw new Error('invalid format');

  const { sock } = await dial(parsedProxy, targetHost, targetPort, opts.timeouts.tcpMs);
  const res = await tlsHandshake(sock, targetHost, { insecure: opts.insecure, timeout: opts.timeouts.tlsMs });

  const selfSigned = isSoftTlsError(res);

  if (opts.strictTLS && !res.authorized) {
    const err = new Error(`TLS invalid/self-signed: ${res.authorizationError || 'unauthorized'}`);
    Object.assign(err, { tlsResult: res });
    throw err;
  }

  return {
    authorized: res.authorized,
    error: res.authorizationError,
    selfSigned,
    protocol: res.protocol,
  };
}
