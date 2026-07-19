import { parseLine, dial } from '../../proxy/dial'
import { tlsHandshake, isSelfSignedError } from '../../proxy/tls'

export interface TlsCheckResult {
  authorized: boolean
  error?: string
  selfSigned: boolean
  protocol?: string
}

export async function tlsCheck(proxyRaw: string, targetHost: string, targetPort: number, opts: {
  connectTimeout: number
  insecure: boolean
  strictTLS: boolean
}): Promise<TlsCheckResult> {
  const parsedProxy = parseLine(proxyRaw)
  if (!parsedProxy) throw new Error('invalid format')

  const { sock } = await dial(parsedProxy, targetHost, targetPort, opts.connectTimeout * 1000)

  try {
    const res = await tlsHandshake(sock, targetHost, { insecure: opts.insecure, timeout: opts.connectTimeout * 1000 })
    try { sock.destroy() } catch {}

    const selfSigned = isSelfSignedError(res)

    if (opts.strictTLS && !res.authorized) {
      const err: any = new Error('TLS invalid/self-signed: ' + (res.authorizationError || 'unauthorized'))
      err.tlsResult = res
      throw err
    }

    return {
      authorized: res.authorized,
      error: res.authorizationError,
      selfSigned,
      protocol: res.protocol,
    }
  } catch (e: any) {
    try { sock.destroy() } catch {}
    throw e
  }
}
