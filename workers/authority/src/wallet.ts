import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  toHex,
  verifyMessage,
  type Hex,
} from 'viem';
import {mainnet} from 'viem/chains';
import {
  createSiweMessage,
  parseSiweMessage,
  validateSiweMessage,
} from 'viem/siwe';
import {createSession, SESSION_TTL, stateStore, type AuthEnv} from './auth.js';
import {
  beginAttempt,
  bindIdentity,
  browserLogin,
  opaque,
  requireBrowserOrigin,
} from './browser-login.js';
import {tokenHash} from './encoding.js';
import {body, HttpError, json, requireValue, string} from './http.js';

export async function walletNonce(request: Request, env: AuthEnv) {
  const input = await body(request);
  const flow = opaque(input.flow);
  requireValue(input.chainId === 'eip155:1', 'unsupported_chain');
  // WalletConnect requests the challenge before selecting an account.
  requireValue(
    input.address === '' ||
      (typeof input.address === 'string' &&
        isAddress(input.address, {strict: false})),
    'invalid_address',
  );
  const address = input.address ? getAddress(input.address as string) : '';
  const {login, attempt} = await beginAttempt(request, flow, env);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
  const issuedAt = new Date(Date.now()),
    expirationTime = new Date(Date.now() + SESSION_TTL);
  const data = {
    domain: new URL(env.AUTHORITY_URL).host,
    uri: env.AUTHORITY_URL,
    version: '1' as const,
    nonce,
    statement: 'Sign in to Monoid Authority.',
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
    accountAddress: address,
    chainId: 'eip155:1',
  };
  const message = address
    ? createSiweMessage({
        ...data,
        address,
        chainId: 1,
        issuedAt,
        expirationTime,
      })
    : undefined;
  await stateStore(env).put(
    `login-wallet:${await tokenHash(nonce)}`,
    JSON.stringify({flow, attempt, message, data}),
    login.browserHash,
    Math.min(login.expiresAt, Date.now() + 5 * 60 * 1000),
  );
  return json({message, data});
}

export async function verifyWallet(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
) {
  requireBrowserOrigin(request, env);
  const input = await body(request, 65536);
  const flow = opaque(input.flow);
  // WalletConnect's supported-method recap can exceed 2 KiB.
  const message = string(input.message, 8192);
  const signature = string(input.signature, 62000);
  requireValue(/^0x(?:[a-fA-F0-9]{2})+$/.test(signature), 'invalid_signature');
  const parsed = parseSiweMessage(message);
  requireValue(parsed.nonce, 'invalid_siwe');
  const current = await browserLogin(request, flow, env);
  const saved = await stateStore(env).take(
    `login-wallet:${await tokenHash(parsed.nonce)}`,
    current.proof,
  );
  requireValue(saved, 'invalid_siwe_nonce');
  const challenge = JSON.parse(saved) as {
    flow: string;
    attempt: string;
    message?: string;
    data: {issuedAt: string; expirationTime: string; statement: string};
  };
  requireValue(
    challenge.flow === flow && challenge.attempt === current.login.attempt,
    'login_changed',
  );
  requireValue(
    (!challenge.message || challenge.message === message) &&
      parsed.chainId === 1 &&
      parsed.version === '1' &&
      parsed.uri === env.AUTHORITY_URL &&
      parsed.expirationTime &&
      parsed.issuedAt?.getTime() === Date.parse(challenge.data.issuedAt) &&
      parsed.expirationTime.getTime() ===
        Date.parse(challenge.data.expirationTime) &&
      (parsed.statement === challenge.data.statement ||
        parsed.statement?.startsWith(challenge.data.statement + ' ')) &&
      validateSiweMessage({
        message: parsed,
        domain: new URL(env.AUTHORITY_URL).host,
        time: new Date(Date.now()),
      }),
    'invalid_siwe',
  );
  const address = getAddress(parsed.address!);
  // Require a complete SIWE message, including any WalletConnect recap. Recaps
  // are signed text only here and grant no additional Authority permissions.
  requireValue(
    createSiweMessage({
      ...parsed,
      address,
      chainId: 1,
      domain: parsed.domain!,
      uri: parsed.uri,
      version: '1',
      nonce: parsed.nonce,
      issuedAt: parsed.issuedAt!,
    }).replace(`\n${address}\n`, `\n${parsed.address}\n`) === message,
    'invalid_siwe',
  );
  let valid = false;
  try {
    valid = await verifyMessage({
      address,
      message,
      signature: signature as Hex,
    });
  } catch {}
  if (!valid) {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(env.ETHEREUM_RPC_URL, {
        fetchFn: fetcher,
        retryCount: 0,
        timeout: 10000,
      }),
    });
    try {
      if ((await client.getChainId()) !== 1) throw new Error('Wrong RPC chain');
      // viem's universal verifier handles deployed ERC-1271 and ERC-6492 signatures.
      valid = await client.verifyMessage({
        address,
        message,
        signature: signature as Hex,
      });
    } catch {
      throw new HttpError(502, 'wallet_verification_unavailable');
    }
  }
  requireValue(valid, 'invalid_signature');
  const session = createSession(
    {
      source: 'wallet',
      id: `eip155:${address.toLowerCase()}`,
      displayName: address,
    },
    parsed.expirationTime!.getTime(),
  );
  await bindIdentity(request, flow, challenge.attempt, env, session);
  return json({account: session.account});
}
