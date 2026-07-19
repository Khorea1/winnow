import net from 'net'

export interface ParsedProxy {
  raw: string
  url: URL
  proto: string
}

export function parseLine(line: string): ParsedProxy | null {
  line = line.trim()
  if (!line || line.startsWith('#')) return null
  if (!line.includes('://')) line = 'http://' + line
  try {
    const u = new URL(line)
    return { raw: line, url: u, proto: u.protocol.replace(':', '') }
  } catch {
    return null
  }
}

export function parseHostPort(input: string, defaultPort = 443): { host: string; port: number } | null {
  if (!input) return null
  input = input.trim()
  if (input.startsWith('[')) {
    const closeIdx = input.indexOf(']')
    if (closeIdx === -1) return null
    const host = input.slice(1, closeIdx)
    const rest = input.slice(closeIdx + 1)
    if (!rest) return { host, port: defaultPort }
    if (rest.startsWith(':')) {
      const port = parseInt(rest.slice(1), 10)
      return { host, port: Number.isFinite(port) ? port : defaultPort }
    }
    return { host, port: defaultPort }
  }
  // Bare IPv6 literal without brackets (e.g. `::1`). Must check before
  // last-colon logic below, which would split on the colon inside the address.
  // Also handle `::1:8080` — IPv6 with a port suffix but no brackets.
  if (input.includes('::')) {
    const lastColon = input.lastIndexOf(':')
    const portStr = input.slice(lastColon + 1)
    // If there's a numeric port suffix and we're past the :: sequence,
    // treat the part before the last colon as the host.
    if (/^\d+$/.test(portStr) && lastColon > 1) {
      const host = input.slice(0, lastColon)
      const port = parseInt(portStr, 10)
      return { host, port: Number.isFinite(port) ? port : defaultPort }
    }
    return { host: input, port: defaultPort }
  }
  const lastColon = input.lastIndexOf(':')
  if (lastColon === -1) return { host: input, port: defaultPort }
  const host = input.slice(0, lastColon)
  const portStr = input.slice(lastColon + 1)
  if (host.includes(':') && !/^\d+$/.test(portStr)) {
    return { host: input, port: defaultPort }
  }
  const port = parseInt(portStr, 10)
  return { host, port: Number.isFinite(port) ? port : defaultPort }
}

// CONNECT handshake uses `timeout` ms (typically 3500). After success the
// caller's data timeout applies — no separate phase needed.
export function httpConnect(upstream: ParsedProxy, tHost: string, tPort: number, timeout: number): Promise<{ sock: net.Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = upstream.url
    const ph = u.hostname
    const pp = parseInt(u.port) || 8080
    const user = u.username
    const pass = u.password
    // FIX: evita nested template literal que quebra tsc - usa concatenacao
    let auth = ''
    if (user) {
      const token = Buffer.from(user + ':' + pass).toString('base64')
      auth = 'Proxy-Authorization: Basic ' + token + '\r\n'
    }
    const sock = net.connect(pp, ph)
    let done = false
    let buf = Buffer.alloc(0)
    const to = setTimeout(() => {
      if (!done) {
        done = true
        sock.destroy()
        reject(new Error('timeout http'))
      }
    }, timeout)

    sock.on('connect', () => {
      const req = 'CONNECT ' + tHost + ':' + tPort + ' HTTP/1.1\r\nHost: ' + tHost + ':' + tPort + '\r\n' + auth + 'Connection: keep-alive\r\n\r\n'
      sock.write(req)
    })
    sock.on('data', (d: Buffer) => {
      if (done) return
      buf = Buffer.concat([buf, d])
      const headEnd = buf.indexOf('\r\n\r\n')
      if (headEnd === -1) return
      const headStr = buf.slice(0, headEnd).toString()
      const firstLine = headStr.split('\r\n')[0] || ''
      const parts = firstLine.split(' ')
      const code = parseInt(parts[1], 10)
      if (code === 200) {
        done = true
        clearTimeout(to)
        resolve({ sock, head: buf.slice(headEnd + 4) })
      } else if (code >= 400 || code === 0) {
        done = true
        clearTimeout(to)
        sock.destroy()
        reject(new Error('proxy refused ' + firstLine))
      }
    })
    sock.on('error', (e) => {
      if (!done) {
        done = true
        clearTimeout(to)
        reject(e)
      }
    })
    sock.on('close', () => {
      if (!done) {
        done = true
        clearTimeout(to)
        reject(new Error('closed before 200'))
      }
    })
  })
}

// CONNECT handshake uses `timeout` ms (typically 3500). After success the
// caller's data timeout applies — no separate phase needed.
export function socks5Connect(upstream: ParsedProxy, tHost: string, tPort: number, timeout: number): Promise<{ sock: net.Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = upstream.url
    const ph = u.hostname
    const pp = parseInt(u.port) || 1080
    const sock = net.connect(pp, ph)
    let done = false
    const to = setTimeout(() => {
      if (!done) {
        done = true
        sock.destroy()
        reject(new Error('timeout socks5'))
      }
    }, timeout)
    let stage = 0
    sock.on('connect', () => {
      if (u.username) sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]))
      else sock.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    sock.on('data', (data: Buffer) => {
      if (done) return
      if (stage === 0) {
        if (data[1] === 0x02) {
          const user = u.username
          const pass = u.password
          const b = Buffer.alloc(3 + user.length + pass.length)
          b[0] = 0x01
          b[1] = user.length
          b.write(user, 2)
          b[2 + user.length] = pass.length
          b.write(pass, 3 + user.length)
          sock.write(b)
          stage = 1
          return
        }
        if (data[1] !== 0x00) {
          done = true
          clearTimeout(to)
          sock.destroy()
          reject(new Error('socks5 no auth'))
          return
        }
        const hb = Buffer.from(tHost)
        const pb = Buffer.alloc(2)
        pb.writeUInt16BE(tPort, 0)
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, pb]))
        stage = 2
      } else if (stage === 1) {
        if (data[1] !== 0x00) {
          done = true
          clearTimeout(to)
          sock.destroy()
          reject(new Error('socks5 auth fail'))
          return
        }
        const hb = Buffer.from(tHost)
        const pb = Buffer.alloc(2)
        pb.writeUInt16BE(tPort, 0)
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, pb]))
        stage = 2
      } else {
        if (data[1] !== 0x00) {
          done = true
          clearTimeout(to)
          sock.destroy()
          reject(new Error('socks5 connect fail ' + data[1]))
          return
        }
        done = true
        clearTimeout(to)
        resolve({ sock, head: Buffer.alloc(0) })
      }
    })
    sock.on('error', (e) => {
      if (!done) {
        done = true
        clearTimeout(to)
        reject(e)
      }
    })
  })
}

export async function dial(upstream: ParsedProxy, h: string, p: number, timeout: number) {
  return upstream.proto.startsWith('socks') ? socks5Connect(upstream, h, p, timeout) : httpConnect(upstream, h, p, timeout)
}

// Blocked ranges for proxy CONNECT/HTTP targets (SSRF prevention).
// IPv4: loopback 127/8, link-local 169.254/16, RFC 1918 (10/8, 172.16/12,
// 192.168/16), RFC 6598 CGNAT (100.64/10). Hostnames: localhost, *.local,
// *.internal. IPv6: loopback ::1, IPv4-mapped private ranges via ::ffff:.
// ULA (fc00::/7) is NOT blocked — internal networks legitimately use it.
export function isBlockedTarget(host: string): boolean {
  // Hostname-based blocking (SSRF prevention for internal hostnames)
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower === '127.0.0.1' || lower === '::1' || lower === '0.0.0.0') return true
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true

  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (m) {
    const [a, b] = [parseInt(m[1]), parseInt(m[2])]
    if (a === 127) return true                  // loopback
    if (a === 169 && b === 254) return true     // link-local (incl. AWS IMDS)
    if (a === 10) return true                    // RFC 1918 10/8
    if (a === 100 && b >= 64 && b <= 127) return true  // RFC 6598 CGNAT
    if (a === 172 && b >= 16 && b <= 31) return true   // RFC 1918 172.16/12
    if (a === 192 && b === 168) return true            // RFC 1918 192.168/16
  }

  // IPv6 checks
  if (net.isIPv6(host)) {
    // IPv6 loopback (::1 and full form)
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
    // IPv4-mapped IPv6: block all private ranges
    const v4mapped = lower.replace(/^::ffff:/, '').replace(/^0:0:0:0:0:0:ffff:/, '')
    if (v4mapped !== lower && /^\d+\.\d+\.\d+\.\d+$/.test(v4mapped)) {
      const parts = v4mapped.split('.').map(Number)
      if (parts[0] === 127) return true
      if (parts[0] === 169 && parts[1] === 254) return true
      if (parts[0] === 10) return true
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
      if (parts[0] === 192 && parts[1] === 168) return true
    }
  }

  return false
}
