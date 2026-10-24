import {createAppKit} from '@reown/appkit';
import {EthersAdapter} from '@reown/appkit-adapter-ethers';
import {ReownAuthentication} from '@reown/appkit-controllers/features';
import {mainnet} from '@reown/appkit/networks';
import {AuthorityClient, ApiError, encode, decode, random} from './client.mjs';
import {LoginLifecycle} from './login-lifecycle.mjs';

const endpoint = 'http://localhost:8787/api/authority';
const projectId =
  import.meta.env.VITE_REOWN_PROJECT_ID ?? 'db10694c682f513cc020fe1937646807';
const storagePrefix = `monoid-authority-demo:${projectId}`;
const authStorageKey = `${storagePrefix}:reown-auth`;
const nonceStorageKey = `${storagePrefix}:reown-nonce`;
const signedOutStorageKey = `${storagePrefix}:signed-out`;
const lifecycle = new LoginLifecycle(
  sessionStorage.getItem(signedOutStorageKey) === '1',
);
const client = new AuthorityClient(endpoint);
const siwx = new ReownAuthentication({
  localAuthStorageKey: authStorageKey,
  localNonceStorageKey: nonceStorageKey,
});
const appkit = createAppKit({
  projectId,
  adapters: [new EthersAdapter()],
  networks: [mainnet],
  siwx,
  metadata: {
    name: 'Monoid Authority Demo',
    description: 'Local Authority authentication demo',
    url: location.origin,
    icons: [],
  },
  features: {
    analytics: false,
    swaps: false,
    onramp: false,
    email: true,
    socials: ['google', 'github', 'apple'],
  },
  themeMode: 'light',
});

const element = (id: string) => document.getElementById(id)!;
const button = (id: string) => element(id) as HTMLButtonElement;
const setStatus = (text: string) => {
  element('status').textContent = text;
};
element('endpoint').textContent = endpoint;

type Namespace = {source: string; id: string; displayName: string};
let tokenInUse: string | null = null;
let uiRevision = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingGitHub:
  | {
      popup: Window;
      state: string;
      verifier: string;
      revision: number;
      timer: ReturnType<typeof setTimeout>;
    }
  | undefined;

function clearProviderCredentials() {
  localStorage.removeItem(authStorageKey);
  localStorage.removeItem(nonceStorageKey);
}

function resumeLogin() {
  if (lifecycle.signedOut) lifecycle.resume();
  sessionStorage.removeItem(signedOutStorageKey);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      github_not_configured:
        '本地尚未配置 GitHub OAuth，可先使用 Reown 或钱包身份。',
      reown_reauthentication_required: 'Reown 会话已失效，请重新登录。',
      reown_verification_rejected:
        'Reown 拒绝了服务端验证请求，请检查项目和服务配置。',
      invalid_reown_origin:
        '登录来源不匹配，请检查 Worker 的 REOWN_AUTH_ORIGINS。',
      invalid_reown_identity: 'Reown 返回的身份不符合当前验证要求。',
      rate_limited: '请求过于频繁，请一分钟后重试。',
      unauthorized: 'Authority 会话已过期，请同步登录状态或重新登录。',
    };
    return (
      messages[error.message] ?? `请求失败：${error.message} (${error.status})`
    );
  }
  return '请求未完成，请检查本地 Worker 和网络连接后重试。';
}

function cancelGitHub() {
  if (!pendingGitHub) return;
  clearTimeout(pendingGitHub.timer);
  pendingGitHub.popup.close();
  pendingGitHub = undefined;
}

function clearUI() {
  ++uiRevision;
  clearTimeout(expiryTimer);
  cancelGitHub();
  element('connection').textContent = '未登录';
  element('account').textContent = '使用 AppKit 选择钱包、邮箱或社交账号。';
  element('namespaces').textContent = '登录后显示可管理的身份。';
  button('logout').disabled = true;
  button('github').disabled = true;
}

async function namespaces() {
  const revision = uiRevision;
  const result = await client.request('/v1/namespaces');
  if (revision !== uiRevision) return;
  const container = element('namespaces');
  container.replaceChildren();
  for (const namespace of result.namespaces as Namespace[]) {
    const item = document.createElement('div');
    item.className = 'namespace';
    const source = document.createElement('div');
    source.className = 'source';
    source.textContent = namespace.source;
    const id = document.createElement('code');
    id.textContent = namespace.id;
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.value = namespace.displayName;
    input.required = true;
    input.maxLength = 128;
    input.setAttribute('aria-label', `${namespace.source} 显示名称`);
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'secondary';
    save.textContent = '保存名称';
    form.append(input, save);
    item.append(source, id, form);
    container.append(item);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        await client.request('/v1/namespaces/name', {
          owner: {source: namespace.source, id: namespace.id},
          displayName: input.value,
        });
        if (revision === uiRevision)
          setStatus('显示名称已保存，永久 ID 和 Bundle 保持不变。');
      } catch (error) {
        if (revision === uiRevision) setStatus(errorMessage(error));
      } finally {
        save.disabled = false;
      }
    });
  }
}

async function sessionReady(session: {
  expiresIn: number;
  account: {login: string; id: string};
}) {
  element('connection').textContent = '已登录';
  element('account').textContent = session.account.login;
  button('logout').disabled = false;
  button('github').disabled = false;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    tokenInUse = null;
    clearUI();
    void client.logout().catch(() => {});
    setStatus('Authority 会话已过期，请同步登录状态。');
  }, session.expiresIn * 1000);
  setStatus('Authority 已验证登录身份。');
  await namespaces();
}

async function syncLogin(force = false, providerEvent = false) {
  if (lifecycle.signedOut) {
    // AppKit can finish a pending signature after logout. Discard the late JWT
    // instead of exchanging it for a new Authority session.
    if (providerEvent) clearProviderCredentials();
    return;
  }
  const connected = appkit.getAccount();
  const connection = connected?.isConnected ? connected.caipAddress : undefined;
  if (lifecycle.setConnection(connection)) {
    tokenInUse = null;
    clearUI();
    void client.logout().catch(() => {});
  }
  if (!connection) {
    setStatus('请先连接钱包并完成 AppKit 身份签名。');
    return;
  }
  const token = localStorage.getItem(authStorageKey);
  if (!token) {
    tokenInUse = null;
    clearUI();
    const revision = uiRevision;
    try {
      await client.logout();
    } catch (error) {
      if (revision === uiRevision) setStatus(errorMessage(error));
      return;
    }
    if (revision === uiRevision) setStatus('请先完成 AppKit 登录和身份签名。');
    return;
  }
  if (!force && token === tokenInUse) return;
  tokenInUse = token;
  clearUI();
  const revision = uiRevision;
  const intent = lifecycle.snapshot();
  setStatus('正在验证 Reown 会话…');
  try {
    const provider = await siwx.getSessionAccount();
    if (revision !== uiRevision || !lifecycle.isCurrent(intent)) return;
    if (localStorage.getItem(authStorageKey) !== token) {
      tokenInUse = null;
      return;
    }
    if (!lifecycle.accepts(intent, provider)) {
      tokenInUse = null;
      await client.logout();
      if (revision === uiRevision)
        setStatus('钱包已切换，请为当前钱包完成 AppKit 身份签名。');
      return;
    }
    const session = await client.login(token);
    if (session && revision === uiRevision && lifecycle.isCurrent(intent))
      await sessionReady(session);
  } catch (error) {
    if (revision === uiRevision) {
      tokenInUse = null;
      setStatus(errorMessage(error));
    }
  }
}

siwx.on('sessionChanged', () => {
  void syncLogin(false, true).catch(error => setStatus(errorMessage(error)));
});
window.addEventListener('storage', event => {
  if (event.key === authStorageKey)
    void syncLogin().catch(error => setStatus(errorMessage(error)));
});
appkit.subscribeAccount(account => {
  if (
    !lifecycle.setConnection(
      account.isConnected ? account.caipAddress : undefined,
    )
  )
    return;
  tokenInUse = null;
  clearUI();
  void client.logout().catch(() => {});
  if (lifecycle.signedOut) {
    return;
  }
  void syncLogin().catch(error => setStatus(errorMessage(error)));
});
button('login').onclick = () => {
  resumeLogin();
  void appkit.open().catch(() => setStatus('无法打开 AppKit，请刷新后重试。'));
};
button('refresh').onclick = () => {
  resumeLogin();
  void syncLogin(true).catch(error => setStatus(errorMessage(error)));
};
button('logout').onclick = async () => {
  lifecycle.signOut();
  sessionStorage.setItem(signedOutStorageKey, '1');
  tokenInUse = null;
  clearUI();
  // Clear local provider tokens before disconnect; invalidate pending exchanges.
  clearProviderCredentials();
  const results = await Promise.allSettled([
    client.logout(),
    appkit.disconnect(),
  ]);
  if (lifecycle.signedOut) {
    clearProviderCredentials();
    setStatus(
      results.some(r => r.status === 'rejected')
        ? '本地已退出；远端会话注销未确认，最多 15 分钟后过期。'
        : '已退出登录。',
    );
  }
};

button('github').onclick = async () => {
  cancelGitHub();
  // Open synchronously within the click to avoid popup blocking.
  const popup = window.open(
    'about:blank',
    'monoid-authority-github',
    'width=620,height=760',
  );
  if (!popup) {
    setStatus('请允许此页面打开 GitHub 登录窗口。');
    return;
  }
  const state = random(),
    verifier = random(),
    revision = uiRevision;
  const timer = setTimeout(
    () => {
      cancelGitHub();
      setStatus('GitHub 连接已超时，请重试。');
    },
    10 * 60 * 1000,
  );
  pendingGitHub = {popup, state, verifier, revision, timer};
  try {
    const codeChallenge = encode(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    );
    const result = await client.request('/auth/github/start', {
      state,
      codeChallenge,
      redirectUri: `${location.origin}/authority/callback`,
    });
    if (pendingGitHub?.popup === popup && revision === uiRevision)
      popup.location.href = result.authorizationUrl;
  } catch (error) {
    if (pendingGitHub?.popup === popup) cancelGitHub();
    setStatus(errorMessage(error));
  }
};

window.addEventListener('message', event => {
  const flow = pendingGitHub;
  if (
    !flow ||
    event.origin !== location.origin ||
    event.source !== flow.popup ||
    flow.revision !== uiRevision
  )
    return;
  const data = event.data;
  if (
    !data ||
    data.type !== 'monoid-authority-github' ||
    data.state !== flow.state ||
    typeof data.code !== 'string'
  )
    return;
  cancelGitHub();
  void client
    .connectGitHub(data.code, flow.verifier)
    .then(async session => {
      if (session && flow.revision === uiRevision) await sessionReady(session);
    })
    .catch(error => {
      if (flow.revision === uiRevision) setStatus(errorMessage(error));
    });
});

button('time').onclick = async () => {
  button('time').disabled = true;
  element('time-status').textContent = '正在请求…';
  try {
    const challenge = random();
    const metadata = await client.request('/v1/metadata');
    const proof = await client.request('/v1/time', {challenge});
    const data = decode(proof.data);
    if (
      proof.publicKey !== metadata.publicKey ||
      data.length !== 41 ||
      data[0] !== 1 ||
      encode(data.slice(9)) !== challenge
    )
      throw new Error('invalid_time_proof');
    const key = await crypto.subtle.importKey(
      'raw',
      decode(metadata.publicKey),
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify'],
    );
    const label = new TextEncoder().encode('Monoid Authority Time');
    const message = new Uint8Array(label.length + data.length);
    message.set(label);
    message.set(data, label.length);
    if (
      !(await crypto.subtle.verify(
        {name: 'ECDSA', hash: 'SHA-256'},
        key,
        decode(proof.signature),
        message,
      ))
    )
      throw new Error('invalid_signature');
    const timestamp =
      Number(
        new DataView(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        ).getBigUint64(1),
      ) * 1000;
    element('time-status').textContent =
      `验签通过 · ${new Date(timestamp).toLocaleString()} · challenge 匹配`;
  } catch (error) {
    element('time-status').textContent = errorMessage(error);
  } finally {
    button('time').disabled = false;
  }
};

setStatus('请选择登录方式；时间证明可以直接测试。');
void syncLogin().catch(error => setStatus(errorMessage(error)));
