export interface ProxyEvent {
  id: number;
  ts: number;
  type: 'connect' | 'http' | 'healthcheck' | 'retry' | 'ban' | 'unban' | 'freeze' | 'freeze_extended' | 'demoted' | 'classify' | 'pool';
  proxy: string;
  target: string;
  status: 'attempt' | 'success' | 'failure' | 'info';
  error?: string;
  errorCode?: string;
  errorClass?: 'fatal' | 'transient';
  latency?: number;
  bytes?: number;
  detail?: string;
}

export class EventLog {
  private _buffer: (ProxyEvent | undefined)[];
  private _head = 0;
  private _tail = 0;
  private _size = 0;
  private _max: number;
  private nextId = 1;
  private listeners: Set<(e: ProxyEvent) => void> = new Set();

  constructor(maxSize = 2000) {
    this._max = maxSize;
    this._buffer = new Array(maxSize);
  }

  subscribe(fn: (e: ProxyEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  unsubscribe(fn: (e: ProxyEvent) => void) {
    this.listeners.delete(fn);
  }

  push(event: Omit<ProxyEvent, 'id' | 'ts'>): ProxyEvent {
    const e: ProxyEvent = {
      id: this.nextId++,
      ts: Date.now(),
      ...event,
    };
    this._buffer[this._head] = e;
    this._head = (this._head + 1) % this._max;
    if (this._size < this._max) {
      this._size++;
    } else {
      this._tail = (this._tail + 1) % this._max;
    }
    // Notify listeners — failures must never crash the app
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {}
    }
    return e;
  }

  static safePush(el: EventLog | undefined, event: Omit<ProxyEvent, 'id' | 'ts'>): void {
    if (el) {
      try {
        el.push(event);
      } catch {
        /* event logging never crashes the app */
      }
    }
  }

  recent(limit?: number): ProxyEvent[] {
    const count = Math.min(limit ?? this._size, this._size);
    const result: ProxyEvent[] = [];
    const start = this._size > count ? (this._tail + (this._size - count)) % this._max : this._tail;
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % this._max;
      const entry = this._buffer[idx];
      if (entry) result.push(entry);
    }
    return result;
  }

  get all(): ProxyEvent[] {
    const result: ProxyEvent[] = [];
    for (let i = 0; i < this._size; i++) {
      const idx = (this._tail + i) % this._max;
      const entry = this._buffer[idx];
      if (entry) result.push(entry);
    }
    return result;
  }

  clear(): void {
    this._buffer = new Array(this._max);
    this._head = 0;
    this._tail = 0;
    this._size = 0;
  }
}
