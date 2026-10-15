const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

export function parseWalletConnectUri(value: string): string | undefined {
  let uri: URL;

  try {
    uri = new URL(value.trim());
  } catch {
    return undefined;
  }

  if (
    uri.protocol !== 'wc:' ||
    !/^[0-9a-f]{64}@2$/i.test(uri.pathname) ||
    uri.host ||
    uri.hash
  ) {
    return undefined;
  }

  const parameters = uri.searchParams;
  const keys = parameters.getAll('symKey');
  const relays = parameters.getAll('relay-protocol');
  const expiries = parameters.getAll('expiryTimestamp');

  if (
    keys.length !== 1 ||
    !HEX_32_BYTES.test(keys[0]!) ||
    relays.length !== 1 ||
    relays[0] !== 'irn' ||
    expiries.length > 1
  ) {
    return undefined;
  }

  if (expiries.length) {
    const expiry = Number(expiries[0]);

    if (
      !/^\d+$/.test(expiries[0]!) ||
      !Number.isSafeInteger(expiry) ||
      expiry * 1000 <= Date.now()
    ) {
      return undefined;
    }
  }

  return uri.href;
}
