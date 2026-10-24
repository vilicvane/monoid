import {HttpError} from './http.js';
import type {Account} from './domain.js';

export interface ReownEnv {
  REOWN_PROJECT_ID: string;
  REOWN_AUTH_ORIGINS: string;
}

export interface ReownIdentity {
  account: Account;
  wallet?: Account;
  expiresAt: number;
}

// Mirrors ReownAuthentication.getSessionAccount() in AppKit 1.8.24.
// Validate remotely; decoding a JWT or trusting client metadata is not authentication.
export async function reownIdentity(
  token: string,
  env: ReownEnv,
  fetcher: typeof fetch,
): Promise<ReownIdentity> {
  if (!env.REOWN_PROJECT_ID) throw new HttpError(503, 'reown_not_configured');
  const url = new URL('https://api.web3modal.org/auth/v1/me');
  url.searchParams.set('projectId', env.REOWN_PROJECT_ID);
  // Reown requires both SDK identifiers before it validates the credential.
  // Keep these aligned with the AppKit version used by the demo integration.
  url.searchParams.set('st', 'appkit');
  url.searchParams.set('sv', 'html-ethers-1.8.24');

  const response = await fetcher(url.href, {
    headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401)
    throw new HttpError(401, 'reown_reauthentication_required');
  if (response.status === 403)
    throw new HttpError(502, 'reown_verification_rejected');
  if (!response.ok) throw new HttpError(502, 'reown_unavailable');

  const claims = await response.json<Record<string, unknown>>();
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    claims.projectIdKey !== env.REOWN_PROJECT_ID ||
    typeof claims.profileUuid !== 'string' ||
    !uuid.test(claims.profileUuid) ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp * 1000 <= Date.now() ||
    typeof claims.uri !== 'string' ||
    typeof claims.address !== 'string'
  ) {
    throw new HttpError(401, 'invalid_reown_identity');
  }

  let uri: URL;
  try {
    uri = new URL(claims.uri);
  } catch {
    throw new HttpError(401, 'invalid_reown_identity');
  }
  const origins = JSON.parse(env.REOWN_AUTH_ORIGINS) as string[];
  if (
    !origins.includes(uri.origin) ||
    claims.domain !== uri.host ||
    uri.username ||
    uri.password
  )
    throw new HttpError(401, 'invalid_reown_origin');

  return {
    // Include the fixed project ID to prevent identities crossing project boundaries.
    account: {
      id: `${env.REOWN_PROJECT_ID}:${claims.profileUuid.toLowerCase()}`,
      login: claims.address,
    },
    wallet: walletIdentity(claims),
    expiresAt: claims.exp * 1000,
  };
}

// Only the wallet authenticated by this SIWX session is usable. Linked wallet
// metadata is not proof of current control. Scope by CAIP chain namespace;
// EVM addresses are case-insensitive, other address encodings preserve case.
function walletIdentity(claims: Record<string, unknown>): Account | undefined {
  const namespace = claims.chainNamespace;
  const address = claims.address;
  if (
    typeof namespace !== 'string' ||
    !/^[a-z0-9-]{3,8}$/.test(namespace) ||
    typeof address !== 'string' ||
    !/^[a-zA-Z0-9]{1,128}$/.test(address)
  )
    return undefined;
  if (namespace === 'eip155' && !/^0x[0-9a-fA-F]{40}$/.test(address))
    return undefined;
  const canonical = namespace === 'eip155' ? address.toLowerCase() : address;
  return {id: `${namespace}:${canonical}`, login: address};
}
