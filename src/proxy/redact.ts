/** Redact proxy userinfo from proxy URLs and arbitrary error text. */
export function redactProxy(value: string): string {
  return value.replace(/((?:[a-z][a-z\d+.-]*:\/\/)?)(?:([^:/\s@?#]+)(?::([^/@\s?#]*))?|:([^/@\s?#]+))@/gi, (_match, prefix: string) => prefix + '***:***@');
}
