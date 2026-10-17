import {Capacitor, CapacitorHttp} from '@capacitor/core';
import {base64} from '@scure/base';

import type {StorageService} from './storage-service.js';

const MAX_LOGOS = 64;
const MAX_CACHE_SIZE = 8 * 1024 * 1024;
const MAX_IMAGE_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT = 8000;
const INLINE_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i;

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    siteLogos: Record<string, string>;
  }
}

export class SiteLogoService {
  private logos: Map<string, string>;
  private loading = new Map<string, Promise<string>>();
  private writing = Promise.resolve();

  private constructor(
    private storage: StorageService,
    saved: StorageMapping['siteLogos'] = {},
  ) {
    this.logos = new Map(Object.entries(saved));
    this.trim();
  }

  getCached(urls: readonly string[]): {url: string; src: string} | undefined {
    for (const url of urls) {
      const src = INLINE_IMAGE.test(url) ? url : this.logos.get(url);
      if (src) return {url, src};
    }
    return undefined;
  }

  load(url: string): Promise<string> {
    const cached = this.getCached([url]);
    if (cached) return Promise.resolve(cached.src);

    let loading = this.loading.get(url);
    if (!loading) {
      loading = this.download(url).finally(() => this.loading.delete(url));
      this.loading.set(url, loading);
    }
    return loading;
  }

  remove(url: string): void {
    if (this.logos.delete(url)) void this.save();
  }

  private async download(url: string): Promise<string> {
    const src = Capacitor.isNativePlatform()
      ? await downloadNativeImage(url)
      : await downloadWebImage(url);
    const image = new Image();
    image.src = src;
    await image.decode();

    this.logos.set(url, src);
    this.trim();
    await this.save();
    return src;
  }

  private trim(): void {
    let size = [...this.logos].reduce(
      (total, [url, src]) => total + url.length + src.length,
      0,
    );
    for (const [url, src] of this.logos) {
      if (this.logos.size <= MAX_LOGOS && size <= MAX_CACHE_SIZE) break;
      this.logos.delete(url);
      size -= url.length + src.length;
    }
  }

  private save(): Promise<void> {
    const saved = Object.fromEntries(this.logos);
    this.writing = this.writing
      .then(() => this.storage.set('siteLogos', saved))
      .catch(console.warn);
    return this.writing;
  }

  static async create(storage: StorageService): Promise<SiteLogoService> {
    let saved: StorageMapping['siteLogos'] | undefined;
    try {
      saved = await storage.get('siteLogos');
    } catch (error) {
      console.warn(error);
    }
    return new SiteLogoService(storage, saved ?? {});
  }
}

async function downloadNativeImage(url: string): Promise<string> {
  const response = await CapacitorHttp.get({
    url,
    responseType: 'arraybuffer',
    connectTimeout: REQUEST_TIMEOUT,
    readTimeout: REQUEST_TIMEOUT,
  });
  checkStatus(response.status);
  const contentType = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const mime = imageMime(contentType);
  if (typeof response.data !== 'string') {
    throw new Error('Invalid site logo response.');
  }

  // Android's Base64.DEFAULT response includes line breaks.
  const encoded = response.data.replace(/[\t\n\r ]/g, '');
  if (encoded.length > Math.ceil(MAX_IMAGE_SIZE / 3) * 4) {
    throw new Error('Site logo exceeds 1 MiB.');
  }
  checkImageSize(base64.decode(encoded).length);
  return `data:${mime};base64,${encoded}`;
}

async function downloadWebImage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    checkStatus(response.status);
    const mime = imageMime(response.headers.get('content-type'));
    const bytes = new Uint8Array(await response.arrayBuffer());
    checkImageSize(bytes.length);
    return `data:${mime};base64,${base64.encode(bytes)}`;
  } finally {
    clearTimeout(timeout);
  }
}

function checkStatus(status: number): void {
  if (status < 200 || status >= 300) {
    throw new Error(`Could not load site logo: HTTP ${status}.`);
  }
}

function imageMime(contentType: string | null | undefined): string {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  if (!mime || !/^image\/[a-z0-9.+-]+$/.test(mime)) {
    throw new Error('Site logo response is not an image.');
  }
  return mime;
}

function checkImageSize(size: number): void {
  if (!size || size > MAX_IMAGE_SIZE) {
    throw new Error('Site logo must contain between 1 byte and 1 MiB.');
  }
}
