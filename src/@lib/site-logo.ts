export function getSiteLogoUrls(
  siteUrl: string,
  icons: readonly string[],
): string[] {
  const base = parseHttpUrl(siteUrl);
  const urls = new Set<string>();

  for (const icon of icons) {
    if (!icon.trim()) {
      continue;
    }

    const url = parseHttpUrl(icon, base);

    if (url) {
      urls.add(url.href);
    }

    if (urls.size === 5) {
      break;
    }
  }

  return [...urls];
}

export function parseHttpUrl(value: string, base?: URL): URL | undefined {
  try {
    const url = new URL(value, base);

    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
    ) {
      return url;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
