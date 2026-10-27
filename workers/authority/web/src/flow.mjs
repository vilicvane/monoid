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

  async finish(action, credential) {
    if (this.state !== 'active') return null;
    this.state = 'finishing';
    try {
      const result = await this.request(action, {
        flow: this.flow,
        ...(action === 'complete'
          ? {
              token: credential?.token,
              method: credential?.method,
              ...(credential?.method === 'social'
                ? {provider: credential.provider}
                : {}),
            }
          : {}),
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

export function canonicalConnection(value) {
  if (!value) return undefined;
  const [namespace, chain, ...parts] = value.split(':');
  const address = parts.join(':');
  if (!namespace || !chain || !address) return undefined;
  return `${namespace}:${chain}:${namespace === 'eip155' ? address.toLowerCase() : address}`;
}

// AppKit 1.8.24 getAccount() exposes this only for the active AUTH connector.
// This is presentation metadata, never proof of an identity or an email.
export function signInMethod(account) {
  if (!account?.isConnected) return undefined;
  if (!account.embeddedWalletInfo) return 'wallet';
  const provider = account.embeddedWalletInfo.authProvider;
  if (provider === 'email') return 'email';
  return typeof provider === 'string' && provider ? 'social' : undefined;
}

export function signInProvider(account) {
  return signInMethod(account) === 'social'
    ? account.embeddedWalletInfo.authProvider
    : undefined;
}

export class AccountSelection {
  connection;
  method;
  provider;
  revision = 0;
  stopped = false;

  setConnection(connection, method, provider) {
    const next = canonicalConnection(connection);
    if (
      next === this.connection &&
      method === this.method &&
      provider === this.provider
    )
      return false;
    this.connection = next;
    this.method = method;
    this.provider = provider;
    this.revision++;
    return true;
  }

  invalidate() {
    this.revision++;
  }

  stop() {
    this.stopped = true;
    this.invalidate();
  }

  accepts(revision, account) {
    return (
      !this.stopped &&
      revision === this.revision &&
      Boolean(this.connection) &&
      canonicalConnection(`${account.caip2Network}:${account.address}`) ===
        this.connection
    );
  }
}
