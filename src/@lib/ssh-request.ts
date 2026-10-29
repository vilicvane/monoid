import {
  SSHProtocolError,
  type SSHSignParams,
  SSH_CHAIN_ID,
  SSH_ERROR_CODES,
  SSH_METADATA_METHOD,
  SSH_METHOD,
  decodeBase64,
  encodeBase64,
  parseSSHAccount,
  parseSSHKeyMetadataParams,
  parseSSHSignParams,
  sha256,
} from '@monoid/ssh-protocol';
import type {WalletKitTypes} from '@reown/walletkit';

export function parseSSHRequest(
  request: WalletKitTypes.SessionRequest,
): SSHSignParams {
  if (request.params.request.method !== SSH_METHOD)
    throw new SSHProtocolError(SSH_ERROR_CODES.methodNotFound);
  if (
    request.params.chainId !== SSH_CHAIN_ID ||
    !Number.isSafeInteger(request.params.request.expiryTimestamp)
  ) {
    throw new SSHProtocolError(SSH_ERROR_CODES.invalidParams);
  }
  return parseSSHSignParams(
    request.params.request.params,
    Date.now() / 1000,
    request.params.request.expiryTimestamp,
  );
}

export function assertSSHMetadataRequest(
  request: WalletKitTypes.SessionRequest,
): void {
  if (request.params.request.method !== SSH_METADATA_METHOD)
    throw new SSHProtocolError(SSH_ERROR_CODES.methodNotFound);
  if (
    request.params.chainId !== SSH_CHAIN_ID ||
    !Number.isSafeInteger(request.id) ||
    request.id < 0 ||
    !Number.isSafeInteger(request.params.request.expiryTimestamp)
  )
    throw new SSHProtocolError(SSH_ERROR_CODES.invalidParams);
  if (request.params.request.expiryTimestamp! * 1000 <= Date.now())
    throw new SSHProtocolError(SSH_ERROR_CODES.expired);
  parseSSHKeyMetadataParams(request.params.request.params);
}

export function getSSHSessionAccounts(
  session: {
    namespaces: Record<
      string,
      {accounts: string[]; methods: string[]; chains?: string[]}
    >;
  },
  method: typeof SSH_METHOD | typeof SSH_METADATA_METHOD = SSH_METHOD,
): string[] {
  return Object.entries(session.namespaces).flatMap(([name, value]) =>
    (name === 'monoid' || name === SSH_CHAIN_ID) &&
    value.methods.includes(SSH_METHOD) &&
    value.methods.includes(method) &&
    (!value.chains || value.chains.includes(SSH_CHAIN_ID))
      ? value.accounts.map(account => parseSSHAccount(account).account)
      : [],
  );
}

export type SSHReview = {
  kind: 'authentication' | 'file-signature' | 'unknown';
  title: string;
  fields: [string, string][];
  notice: string;
};

export function reviewSSHData(params: SSHSignParams): SSHReview {
  const bytes = decodeBase64(params.data);
  const digest = `SHA256:${encodeBase64(sha256(bytes)).replace(/=+$/, '')}`;
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new Error('Truncated data');
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const string = (): Uint8Array => {
    const size = take(4);
    const length = new DataView(size.buffer).getUint32(0);
    return take(length);
  };
  const text = (value: Uint8Array): string => {
    const result = new TextDecoder('utf-8', {fatal: true}).decode(value);
    if (
      !result ||
      [...result].some(character => {
        const code = character.codePointAt(0)!;
        return code < 32 || (code >= 127 && code <= 159);
      })
    )
      throw new Error('Invalid text');
    return result;
  };
  const fields: [string, string][] = [
    ['Bytes', String(bytes.length)],
    ['Data digest', digest],
  ];
  try {
    if (new TextDecoder().decode(bytes.slice(0, 6)) === 'SSHSIG') {
      take(6);
      const namespace = text(string());
      const reserved = string();
      const hash = text(string());
      const hashed = string();
      if (
        offset !== bytes.length ||
        reserved.length ||
        !(
          (hash === 'sha256' && hashed.length === 32) ||
          (hash === 'sha512' && hashed.length === 64)
        )
      )
        throw new Error('Invalid SSHSIG');
      return {
        kind: 'file-signature',
        title: 'Sign SSH data',
        fields: [
          ['Namespace', namespace],
          ['File hash algorithm', hash],
          ...fields,
        ],
        notice:
          'Only the file hash is sent to your phone. Confirm only if you initiated this file signature.',
      };
    }
    const sessionId = string();
    if (!sessionId.length || take(1)[0] !== 50) throw new Error('Not userauth');
    const username = text(string());
    if (text(string()) !== 'ssh-connection') throw new Error('Invalid service');
    const method = text(string());
    if (
      !['publickey', 'publickey-hostbound-v00@openssh.com'].includes(method) ||
      take(1)[0] !== 1 ||
      text(string()) !== params.algorithm
    )
      throw new Error('Invalid authentication');
    const key = string();
    const expected = parseSSHAccount(params.account).keyBlob;
    if (
      key.length !== expected.length ||
      !key.every((value, index) => value === expected[index])
    )
      throw new Error('Different key');
    if (method !== 'publickey') string();
    if (offset !== bytes.length) throw new Error('Trailing data');
    return {
      kind: 'authentication',
      title: 'SSH authentication',
      fields: [['Username', username], ...fields],
      notice:
        'Your phone cannot verify the destination hostname. Confirm only if you initiated this connection.',
    };
  } catch {
    return {
      kind: 'unknown',
      title: 'Sign unknown SSH data',
      fields,
      notice:
        'This data is not a recognized SSH authentication or file signature. Its purpose cannot be verified. Reject it unless you trust the request.',
    };
  }
}
