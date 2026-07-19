export interface ValidatorOptions {
  threads: number
  mode: 'quick' | 'standard' | 'strict' | 'stream' | 'tcp-only'
  baseUrl: string
  connectTimeout: number
  maxLatency: number
  ttfbRatio: number
  maxGap: number
  insecure: boolean
  strictTLS: boolean
  anonCheck: boolean
  throttle: number
  tlsHost: string
  tlsPort: number
}

export interface ProxyResult {
  proxy: string
  valid: boolean
  latency?: number
  error?: string
  stage?: string
  httpCode?: number
  ttfb?: number
  chunks?: number
}

export type ProgressCallback = (result: ProxyResult, stats: { total: number; done: number; valid: number; invalid: number }) => void
