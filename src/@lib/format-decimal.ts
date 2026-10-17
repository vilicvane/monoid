export function formatScientificDecimal(
  value: string,
): {coefficient: string; exponent: number} | undefined {
  const match = /^(-?)([1-9]\d{6,})(?:\.(\d+))?$/.exec(value);
  if (!match) return undefined;

  const [, sign, integer, fraction = ''] = match;
  const digits = `${integer.slice(1)}${fraction}`.replace(/0+$/, '');
  return {
    coefficient: `${sign}${integer[0]}${digits ? `.${digits}` : ''}`,
    exponent: integer.length - 1,
  };
}

export function formatDecimal(
  value: string,
  significantDigits = 4,
): {value: string; approximate: boolean} {
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split(
    '.',
  );
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (!digits) return {value: '0', approximate: false};

  let decimalPosition = digits.length - fraction.length;
  let rounded = digits.slice(0, significantDigits);
  const discarded = digits.slice(significantDigits);
  const approximate = /[1-9]/.test(discarded);

  if (discarded && discarded[0] >= '5') {
    const incremented = (BigInt(rounded) + BigInt(1)).toString();
    decimalPosition += incremented.length - rounded.length;
    rounded = incremented;
  }

  let formatted: string;
  if (decimalPosition <= 0) {
    formatted = `0.${'0'.repeat(-decimalPosition)}${rounded}`;
  } else if (decimalPosition >= rounded.length) {
    formatted = rounded + '0'.repeat(decimalPosition - rounded.length);
  } else {
    formatted = `${rounded.slice(0, decimalPosition)}.${rounded.slice(decimalPosition)}`;
  }

  if (formatted.includes('.')) {
    formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
  }

  return {value: negative ? `-${formatted}` : formatted, approximate};
}
