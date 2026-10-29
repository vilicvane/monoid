/** User-facing Authority URLs identify the site, not one of its API endpoints. */
export function normalizeAuthorityUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Invalid authority URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid authority URL');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
}

/** The Authority URL is the worker's base; its API and login live beneath it. */
export function authorityApiUrl(authorityUrl: string, path: string): string {
  return new URL(path, normalizeAuthorityUrl(authorityUrl)).href;
}
