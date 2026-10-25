import {getBytes, sha256, toUtf8Bytes} from 'ethers';

import {
  MonoidIdHex,
  PublicKeyHex,
  SafeIndex,
  SafeIndexHex,
  SafeKnownType,
  SafeUnknownType,
} from '../@atomics.js';
import type {OTPAccount, OTPCard} from '../@services/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../@utils/index.js';

import {AppletISOError, probeApplet} from './applet.js';
import {InvalidCardItemError} from './card-item-error.js';
import {equalBytes} from './global-platform/commands.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  acceptMatchingItem,
  removeItems,
} from './monoid/index.js';
import {createOTPApplet} from './otp-applet.js';
import {
  type OTPImportAccount,
  OTP_AID,
  OTP_ITEM_TYPE,
  decodeOTPConfiguration,
  decodeOTPKeyReference,
  encodeOTPConfiguration,
} from './otp.js';

const accountType = SafeUnknownType.satisfies(OTP_ITEM_TYPE - 0x10000);

/** Probe before PIN authentication; SELECT changes the active applet. */
export async function isOTPInstalled(
  applet: MonoidApplet,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const otp = createOTPApplet().attachSession(applet);
  const installed = await probeApplet(otp, OTP_AID);
  signal.throwIfAborted();
  if (installed) {
    await otp.hello({});
    signal.throwIfAborted();
  }
  return installed;
}

/** Check cached accounts' key references without rereading their metadata. */
export async function assertOTPAccounts(
  applet: MonoidApplet,
  accounts: readonly OTPAccount[],
  signal: AbortSignal,
): Promise<void> {
  for (const account of accounts) {
    signal.throwIfAborted();
    const index = SafeIndex.satisfies(hexToUint8Array(account.index));
    const {data} = await applet.get({index});
    signal.throwIfAborted();
    if (!equalBytes(data, hexToUint8Array(account.keyIndex)))
      throw new MonoidCardError('OTP account does not match');
  }
  signal.throwIfAborted();
}

export async function readOTPAccounts(
  applet: MonoidApplet,
  signal: AbortSignal,
): Promise<OTPAccount[]> {
  return (await readOTPInventory(applet, signal)).accounts;
}

type MonoidListItem = Awaited<
  ReturnType<MonoidApplet['list']>
>['items'][number];

/** A snapshot belongs to this operation only; never reuse it across card taps. */
async function readOTPInventory(
  applet: MonoidApplet,
  signal: AbortSignal,
): Promise<{
  accounts: OTPAccount[];
  items: MonoidListItem[];
  hmacKeys: MonoidListItem[];
}> {
  signal.throwIfAborted();
  const {items} = await applet.list({type: accountType});
  signal.throwIfAborted();
  const {items: hmacKeys} = await applet.list({
    type: SafeKnownType.satisfies('hmac'),
  });
  signal.throwIfAborted();
  const protectedKeys = new Set(
    hmacKeys
      .filter(
        item =>
          item.secret &&
          item.index.length === 10 &&
          item.index[0] === 5 &&
          item.index[1] !== 0,
      )
      .map(item => uint8ArrayToHex(item.index)),
  );
  const accounts: OTPAccount[] = [];
  for (const item of items) {
    signal.throwIfAborted();
    if (
      item.secret ||
      !item.metadata ||
      item.index.length !== 10 ||
      item.index[0] !== 0xf2 ||
      item.index[1] !== 1
    )
      continue;
    let configuration;
    try {
      configuration = decodeOTPConfiguration(item.metadata);
    } catch (error) {
      if (!(error instanceof InvalidCardItemError)) throw error;
      continue;
    }
    const {data} = await applet.get({index: item.index});
    signal.throwIfAborted();
    let keyIndex;
    try {
      keyIndex = decodeOTPKeyReference(data);
    } catch (error) {
      if (!(error instanceof InvalidCardItemError)) throw error;
      continue;
    }
    if (!protectedKeys.has(keyIndex)) continue;
    accounts.push({
      index: SafeIndexHex.satisfies(uint8ArrayToHex(item.index)),
      label: item.alias || 'OTP account',
      ...configuration,
      keyIndex,
    });
  }
  return {accounts, items, hmacKeys};
}

/** Access authentication is already active. The final SELECT leaves OTP selected. */
export async function readOTPCard(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  signal: AbortSignal,
): Promise<OTPCard> {
  const accounts = await readOTPAccounts(applet, signal);
  signal.throwIfAborted();
  const {grants} = await applet.listAppletGrants({});
  signal.throwIfAborted();
  const grant = grants.find(grant => equalBytes(grant.aid, OTP_AID));
  let authorized =
    !!grant?.types?.some(([type]) => type === accountType) &&
    accounts.every(account =>
      grant?.keys?.some(
        key =>
          key.type === 'hmac' &&
          uint8ArrayToHex(key.index) === account.keyIndex,
      ),
    );
  const otp = createOTPApplet().attachSession(applet);
  const installed = await probeApplet(otp, OTP_AID);
  signal.throwIfAborted();
  if (installed) {
    await otp.hello({});
    signal.throwIfAborted();
    if (authorized) {
      try {
        // Hello does not check the grant's installation token. Challenge does.
        await otp.challenge({});
      } catch (error) {
        if (!(error instanceof AppletISOError && error.sw === 0x6982))
          throw error;
        authorized = false;
      }
    }
  }
  signal.throwIfAborted();
  return {
    id: MonoidIdHex.satisfies(uint8ArrayToHex(hello.id)),
    publicKey: PublicKeyHex.satisfies(uint8ArrayToHex(hello.publicKey)),
    installed,
    authorized: installed && authorized,
    accounts,
  };
}

export async function authorizeOTPAccounts(
  applet: MonoidApplet,
  signal: AbortSignal,
): Promise<OTPAccount[]> {
  const accounts = await readOTPAccounts(applet, signal);
  await grantOTPAccounts(applet, accounts, signal);
  return accounts;
}

async function grantOTPAccounts(
  applet: MonoidApplet,
  accounts: readonly OTPAccount[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await applet.setAppletGrant({
    aid: OTP_AID,
    types: [[accountType, false]],
    keys: [...new Set(accounts.map(account => account.keyIndex))].map(
      index => ({
        index: SafeIndex.satisfies(hexToUint8Array(index)),
        type: 'hmac' as const,
      }),
    ),
  });
  signal.throwIfAborted();
}

/** No retry after an uncertain mutation. A later scan reads the actual card state. */
export async function addOTPAccount(
  applet: MonoidApplet,
  account: OTPImportAccount,
  signal: AbortSignal,
): Promise<OTPAccount[]> {
  const metadata = encodeOTPConfiguration(account);
  if (account.secret.length < 1 || account.secret.length > 255)
    throw new MonoidCardError('Secret must contain 1–255 bytes');
  const hmacIndex = SafeIndex.satisfies(
    new Uint8Array([
      5,
      account.secret.length,
      ...getBytes(sha256(account.secret)).subarray(0, 8),
    ]),
  );
  const keyIndex = uint8ArrayToHex(hmacIndex);
  const index = SafeIndex.satisfies(
    new Uint8Array([
      0xf2,
      1,
      ...getBytes(
        sha256(
          new Uint8Array([
            ...toUtf8Bytes('monoid otp account'),
            ...metadata,
            ...hmacIndex,
          ]),
        ),
      ).subarray(0, 8),
    ]),
  );
  const {accounts, items, hmacKeys} = await readOTPInventory(applet, signal);
  const existing = accounts.find(
    item =>
      item.keyIndex === keyIndex &&
      item.algorithm === account.algorithm &&
      item.digits === account.digits &&
      item.period === account.period,
  );
  if (!existing && items.some(item => equalBytes(item.index, index)))
    throw new MonoidCardError('OTP account conflict');
  signal.throwIfAborted();
  const existingKey = hmacKeys.find(item => equalBytes(item.index, hmacIndex));
  if (existingKey && !existingKey.secret)
    throw new MonoidCardError('Existing OTP key is not protected');
  signal.throwIfAborted();
  if (!existingKey) {
    try {
      const created = await applet.create({
        type: SafeKnownType.satisfies('hmac'),
        data: account.secret,
        secret: true,
      });
      if (!equalBytes(created.index, hmacIndex))
        throw new MonoidCardError('Unexpected OTP key');
    } catch (error) {
      await acceptMatchingItem(
        applet,
        {index: hmacIndex, secret: true},
        error,
        signal,
      );
    }
  }
  signal.throwIfAborted();
  if (!existing) {
    const request = {
      index,
      alias: account.label,
      metadata,
      data: hmacIndex,
      secret: false,
    };
    try {
      await applet.create(request);
    } catch (error) {
      await acceptMatchingItem(applet, request, error, signal);
    }
  } else if (existing.label !== account.label) {
    await applet.set({
      index: SafeIndex.satisfies(hexToUint8Array(existing.index)),
      alias: account.label,
    });
  }
  signal.throwIfAborted();
  const added: OTPAccount = {
    index: existing?.index ?? SafeIndexHex.satisfies(uint8ArrayToHex(index)),
    keyIndex: SafeIndexHex.satisfies(keyIndex),
    label: account.label,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
  };
  const next = [...accounts.filter(item => item !== existing), added];
  await grantOTPAccounts(applet, next, signal);
  return next;
}

/** Resolves `undefined` without writing when this card lacks the account. */
export async function removeOTPAccount(
  applet: MonoidApplet,
  account: OTPAccount,
  signal: AbortSignal,
  installed = true,
): Promise<OTPAccount[] | undefined> {
  const {accounts, items: accountItems} = await readOTPInventory(
    applet,
    signal,
  );
  const current = accounts.find(item => item.index === account.index);
  if (!current) return undefined;
  if (
    current.keyIndex !== account.keyIndex ||
    !equalBytes(
      encodeOTPConfiguration(current),
      encodeOTPConfiguration(account),
    )
  )
    throw new MonoidCardError('Account changed, scan card again');
  const {grants} = await applet.listAppletGrants({});
  const shared =
    // An unreadable account may still reference this key. Do not delete its secret.
    accountItems.length > accounts.length ||
    accounts.some(
      item =>
        item.index !== account.index && item.keyIndex === account.keyIndex,
    ) ||
    grants.some(
      grant =>
        !equalBytes(grant.aid, OTP_AID) &&
        grant.keys?.some(
          key => uint8ArrayToHex(key.index) === account.keyIndex,
        ),
    );
  signal.throwIfAborted();
  // Remove the reference before its secret, preserving keys shared by another client.
  await removeItems(
    applet,
    new Set([account.index, ...(!shared ? [account.keyIndex] : [])]),
    signal,
  );
  const next = accounts.filter(item => item.index !== account.index);
  if (installed) await grantOTPAccounts(applet, next, signal);
  return next;
}
