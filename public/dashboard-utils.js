export function classifyProxy(proxy, now, config = {}) {
  if (proxy.frozen) return 'ban';
  if (proxy.banned || now < proxy.bannedUntil) return 'ban';
  const maxErrors = config.maxErrors ?? 3;
  if (proxy.errors >= maxErrors) return 'err';
  const timeout = config.timeout || 3500;
  if (proxy.latency !== 9999 && proxy.latency > timeout * 0.55) return 'warn';
  return 'ok';
}

export function sortAndFilterProxies(proxies, {
  filterTerm = '',
  statusFilter = new Set(),
  sortKey = 'score',
  sortDir = 'asc',
  now,
  config = {},
}) {
  let list = proxies.slice();
  if (filterTerm) {
    list = list.filter((proxy) => proxy.proxy.toLowerCase().includes(filterTerm));
  }
  if (statusFilter.size > 0) {
    list = list.filter((proxy) => statusFilter.has(classifyProxy(proxy, now, config)));
  }
  list.sort((a, b) => {
    let va;
    let vb;
    switch (sortKey) {
      case 'proxy': va = a.proxy; vb = b.proxy; break;
      case 'status': va = classifyProxy(a, now, config); vb = classifyProxy(b, now, config); break;
      case 'score': va = a.score; vb = b.score; break;
      case 'latency': va = a.latency; vb = b.latency; break;
      case 'errors': va = a.errors; vb = b.errors; break;
      case 'ok': va = a.successes; vb = b.successes; break;
      default: va = a.score; vb = b.score;
    }
    if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return list;
}
