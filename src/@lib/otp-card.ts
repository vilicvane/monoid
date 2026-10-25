import {getBytes, sha256} from 'ethers';

import {
  MonoidIdHex,
  PublicKeyHex,
  SafeIndex,
  SafeIndexHex,
  SafeUnknownType,
} from '../@atomics.js';
import type {OTPAccount, OTPCard} from '../@services/index.js';
import {uint8ArrayToHex} from '../@utils/index.js';

import {AppletISOError, probeApplet} from './applet.js';
import {equalBytes} from './global-platform/commands.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  acceptMatchingItem,
  readCardContents,
  removeItems,
} from './monoid/index.js';
import {createOTPApplet} from './otp-applet.js';
import {
  type OTPImportAccount,
  OTP_AID,
  OTP_ITEM_TYPE,
  decodeOTPAccount,
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

/** A snapshot belongs to this operation only; never reuse it across card taps. */
export async function readOTPAccounts(
  applet: MonoidApplet,
  signal: AbortSignal,
): Promise<OTPAccount[]> {
  const {items} = await readCardContents(applet, decodeOTPAccount, {
    filter: {type: accountType},
    check: () => signal.throwIfAborted(),
  });
  return items;
}

/** Access authentication is already active. The final SELECT leaves OTP selected. */
export async function readOTPCard(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  signal: AbortSignal,
  snapshot?: OTPAccount[],
): Promise<OTPCard> {
  const accounts = snapshot ?? (await readOTPAccounts(applet, signal));
  signal.throwIfAborted();
  const {grants} = await applet.listAppletGrants({});
  signal.throwIfAborted();
  const grant = grants.find(grant => equalBytes(grant.aid, OTP_AID));
  let authorized = !!grant?.types?.some(([type]) => type === accountType);
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
  signal.throwIfAborted();
  await applet.setAppletGrant({
    aid: OTP_AID,
    types: [[accountType, false]],
  });
  signal.throwIfAborted();
  return accounts;
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
  const index = SafeIndex.satisfies(
    new Uint8Array([
      0xf2,
      1,
      ...getBytes(sha256(account.secret)).subarray(0, 8),
    ]),
  );
  const accounts = await readOTPAccounts(applet, signal);
  const request = {
    index,
    alias: account.label,
    metadata,
    data: account.secret,
    secret: true,
  };
  signal.throwIfAborted();
  try {
    await applet.create(request);
  } catch (error) {
    // The card validates the digest index, so View can compare the public fields.
    await acceptMatchingItem(applet, request, error, signal);
  }
  signal.throwIfAborted();
  const added: OTPAccount = {
    index: SafeIndexHex.satisfies(uint8ArrayToHex(index)),
    label: account.label,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
  };
  return [...accounts.filter(item => item.index !== added.index), added];
}

/** Resolves undefined without writing when this card lacks the account. */
export async function removeOTPAccount(
  applet: MonoidApplet,
  account: OTPAccount,
  signal: AbortSignal,
): Promise<OTPAccount[] | undefined> {
  const accounts = await readOTPAccounts(applet, signal);
  const current = accounts.find(item => item.index === account.index);
  if (!current) return undefined;
  if (
    !equalBytes(
      encodeOTPConfiguration(current),
      encodeOTPConfiguration(account),
    )
  )
    throw new MonoidCardError('Account changed, scan card again');
  await removeItems(applet, new Set([account.index]), signal);
  return accounts.filter(item => item.index !== account.index);
}
