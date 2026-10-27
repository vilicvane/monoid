export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

export class AuthorityClient {
  token;
  revision = 0;
  constructor(base, fetcher = fetch.bind(globalThis)) {
    this.base = base;
    this.fetcher = fetcher;
  }
  async request(path, body, token = this.token) {
    const response = await this.fetcher(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 204) return undefined;
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(response.status, result.error || 'request_failed');
    return result;
  }
  async login(providerToken, method, provider) {
    const revision = ++this.revision;
    const previous = this.token;
    this.token = undefined;
    if (previous) await this.request('/auth/logout', {}, previous);
    const session = await this.request('/auth/reown', {
      token: providerToken,
      method,
      ...(method === 'social' ? {provider} : {}),
    });
    if (revision !== this.revision) {
      await this.request('/auth/logout', {}, session.accessToken);
      return undefined;
    }
    this.token = session.accessToken;
    return session;
  }
  async logout() {
    ++this.revision;
    const token = this.token;
    this.token = undefined;
    if (token) await this.request('/auth/logout', {}, token);
  }
  async connectGitHub(code, codeVerifier) {
    const revision = this.revision;
    const session = await this.request('/auth/token', {code, codeVerifier});
    if (revision !== this.revision) {
      await this.request('/auth/logout', {}, session.accessToken);
      return undefined;
    }
    this.token = session.accessToken;
    return session;
  }
}

export const encode = bytes =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export const decode = text =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), char =>
    char.charCodeAt(0),
  );
export const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
