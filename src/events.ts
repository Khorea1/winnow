export interface ProxyEvent {
  id: number
  ts: number
  type: 'connect' | 'http' | 'healthcheck' | 'retry' | 'ban' | 'unban' | 'freeze' | 'classify' | 'pool'
  proxy: string
  target: string
  status: 'attempt' | 'success' | 'failure' | 'info'
  error?: string
  errorCode?: string
  errorClass?: 'fatal' | 'transient'
  latency?: number
  bytes?: number
  detail?: string
}

export class EventLog {
  private events: ProxyEvent[] = []
  private nextId = 1
  private maxSize: number
  private listeners: Set<(e: ProxyEvent) => void> = new Set()

  constructor(maxSize = 2000) { this.maxSize = maxSize }

  subscribe(fn: (e: ProxyEvent) => void) { this.listeners.add(fn) }
  unsubscribe(fn: (e: ProxyEvent) => void) { this.listeners.delete(fn) }

  push(event: Omit<ProxyEvent, 'id' | 'ts'>): ProxyEvent {
    const e: ProxyEvent = {
      id: this.nextId++,
      ts: Date.now(),
      ...event,
    }
    this.events.push(e)
    if (this.events.length > this.maxSize) {
      this.events.shift()
    }
    // Notify listeners — failures must never crash the app
    for (const fn of this.listeners) {
      try { fn(e) } catch {}
    }
    return e
  }

  static safePush(el: EventLog | undefined, event: Omit<ProxyEvent, 'id' | 'ts'>): void {
    if (el) {
      try { el.push(event) } catch { /* event logging never crashes the app */ }
    }
  }

  recent(limit?: number): ProxyEvent[] {
    if (limit === undefined || limit >= this.events.length) return this.events.slice()
    return this.events.slice(-limit)
  }

  get all(): ProxyEvent[] {
    return this.events.slice()
  }

  clear(): void {
    this.events = []
  }
}
