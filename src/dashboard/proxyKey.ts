export function sanitizeProxyKey(key: string): string {
  try {
    const u = new URL(key);
    u.username = '';
    u.password = '';
    // URL class adds trailing slash, remove it; also strip protocol prefix for consistent comparison
    return u
      .toString()
      .replace(/\/$/, '')
      .replace(/^[a-z]+:\/\//, '');
  } catch {
    // URL parsing failed — likely protocol-less string with credentials
    // Strip user:password@ prefix if present
    return key.replace(/^[^@]*@/, '');
  }
}
