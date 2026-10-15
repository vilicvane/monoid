export function getSiteLogoUrls(
  siteUrl: string,
  icons: readonly string[],
): string[] {
  const base = parseHttpUrl(siteUrl);
  const urls = new Set<string>();

  for (const icon of icons) {
    const source = icon.trim();

    if (!source) {
      continue;
    }

    const url = parseHttpUrl(source, base);

    if (url) {
      urls.add(url.href);
    } else if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(source)) {
      urls.add(source);
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
