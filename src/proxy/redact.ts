/** Public proxy identifier, without authentication or URL path/query data. */
export function redactProxy(proxy: string): string {
  if (!proxy || proxy === '(all)') return proxy;
  try {
    const url = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    return url.hostname ? url.host : '[invalid proxy]';
  } catch {
    return '[invalid proxy]';
  }
}

/** Remove embedded proxy credentials from diagnostic strings before publication. */
export function redactProxyText(text: string): string {
  return text.replace(
    /(?:(?:[a-z][a-z\d+.-]*:\/\/)[^:\s/?#@]+(?::[^\s/?#]*)?@|[^\s/?#@]+:[^\s/?#]+@|[^\s/?#@]+@(?=[^:\s/?#@,]+:\d+))(?:\[[^\]\s/?#@]+\]|[^:\s/?#@,]+)(?::\d+)?/gi,
    (match) => redactProxy(match),
  );
}
