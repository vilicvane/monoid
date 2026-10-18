import {
  formatBitcoinAmount,
  parseBitcoinAmount,
  validateBitcoinAddress,
} from './bitcoin-transaction.js';

export function parseBitcoinPaymentRequest(value: string): {
  address: string;
  amount?: string;
} {
  const text = value.trim();
  if (!/^bitcoin:/i.test(text)) {
    return {address: validateBitcoinAddress(text)};
  }

  const match = /^bitcoin:([a-z\d]+)(?:\?(.*))?$/i.exec(text);
  if (!match) invalidRequest();
  const address = validateBitcoinAddress(match[1]);
  let amount: string | undefined;

  for (const parameter of (match[2] ?? '').split('&')) {
    if (!parameter) continue;
    const separator = parameter.indexOf('=');
    const name = decodeQueryPart(
      separator === -1 ? parameter : parameter.slice(0, separator),
    );
    const value = decodeQueryPart(
      separator === -1 ? '' : parameter.slice(separator + 1),
    );
    if (!name) invalidRequest();
    if (name.startsWith('req-')) {
      throw new Error(
        'This Bitcoin payment request requires an unsupported option.',
      );
    }
    if (name !== 'amount') continue;
    if (amount !== undefined) {
      throw new Error(
        'This Bitcoin payment request contains more than one amount.',
      );
    }
    // Query amounts cannot use whitespace, even though manually entered
    // amounts may be trimmed by the shared form validator.
    if (value !== value.trim()) invalidRequest();
    amount = formatBitcoinAmount(parseBitcoinAmount(value));
  }

  return amount === undefined ? {address} : {address, amount};
}

function decodeQueryPart(value: string): string {
  // BIP21 uses RFC3986 query escaping: '+' is literal, and malformed percent
  // escapes must not be silently replaced as they are by URLSearchParams.
  if (!/^[a-z\d\-._~!$'()*+,;:@/?%]*$/i.test(value)) invalidRequest();
  try {
    return decodeURIComponent(value);
  } catch {
    return invalidRequest();
  }
}

function invalidRequest(): never {
  throw new Error('Enter a valid Bitcoin address or payment request.');
}
