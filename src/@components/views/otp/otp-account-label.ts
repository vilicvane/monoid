export function splitOTPAccountLabel(label: string): {
  provider: string;
  name: string;
} {
  const separator = label.indexOf(':');
  const provider = separator > 0 ? label.slice(0, separator).trim() : '';
  const name = provider ? label.slice(separator + 1).trim() || label : label;
  return {provider, name};
}

/** The text range of one label part, matching `splitOTPAccountLabel`. */
export function getOTPAccountLabelRange(
  label: string,
  part: 'provider' | 'name',
): {start: number; end: number} {
  const separator = label.indexOf(':');
  if (separator <= 0) return {start: 0, end: label.length};

  if (part === 'provider')
    return {start: 0, end: label.slice(0, separator).trimEnd().length};

  const name = label.slice(separator + 1).trimStart();
  return {start: label.length - name.length, end: label.length};
}
