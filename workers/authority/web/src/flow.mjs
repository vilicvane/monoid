const FLOW_KEY = 'monoid:authority:browser-flow';
const FLOW_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function restoreFlow(location, history, storage) {
  const params = new URLSearchParams(location.search);
  const incoming = params.get('flow');
  // Do this before loading AppKit or any third-party resource.
  history.replaceState(null, '', location.pathname);
  if (params.has('flow')) {
    storage.removeItem(FLOW_KEY);
    if (!incoming || !FLOW_PATTERN.test(incoming)) return null;
    storage.setItem(FLOW_KEY, incoming);
    return incoming;
  }
  const saved = storage.getItem(FLOW_KEY);
  return saved && FLOW_PATTERN.test(saved) ? saved : null;
}

export class LoginError extends Error {}

export class BrowserFlow {
  state = 'active';

  constructor(
    flow,
    storage,
    fetcher = fetch.bind(globalThis),
    base = import.meta.env?.BASE_URL ?? '/',
  ) {
    this.flow = flow;
    this.storage = storage;
    this.fetcher = fetcher;
    this.base = base;
  }

  async request(path, body) {
    const response = await this.fetcher(`${this.base}auth/login/${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? {'Content-Type': 'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok) throw new LoginError(result.error);
    return result;
  }

  context() {
    return this.request(`context?flow=${encodeURIComponent(this.flow)}`);
  }

  async finish(action) {
    if (this.state !== 'active') return null;
    this.state = 'finishing';
    try {
      const result = await this.request(action, {
        flow: this.flow,
      });
      this.state = 'finished';
      if (this.storage.getItem(FLOW_KEY) === this.flow)
        this.storage.removeItem(FLOW_KEY);
      return result.redirectUrl;
    } catch (error) {
      this.state = 'active';
      throw error;
    }
  }
}
