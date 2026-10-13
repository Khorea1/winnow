/** Redact proxy userinfo from proxy URLs and arbitrary error text. */
export function redactProxy(value: string): string {
  return value.replace(/((?:[a-z][a-z\d+.-]*:\/\/)?)(?:([^:/\s@?#]+)(?::([^/@\s?#]*))?|:([^/@\s?#]+))@/gi, (_match, prefix: string) => prefix + '***:***@');
}

/** Public proxy identifier: no credentials, path or query parameters. */
export function publicProxyKey(proxy: string): string {
  if (!proxy || proxy === '(all)') return proxy;
  try {
    const url = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    return url.hostname ? url.host : '[invalid proxy]';
  } catch {
    return '[invalid proxy]';
  }
}

/** Remove credentials from proxy URLs embedded in diagnostic messages. */
export function redactProxyText(text: string): string {
  return text.replace(
    /(?:(?:[a-z][a-z\d+.-]*:\/\/)[^:\s/?#@]+(?::[^\s/?#]*)?@|[^\s/?#@]+:[^\s/?#]+@|[^\s/?#@]+@(?=[^:\s/?#@,]+:\d+))(?:\[[^\]\s/?#@]+\]|[^:\s/?#@,]+)(?::\d+)?/gi,
    (match) => publicProxyKey(match),
  );
}
