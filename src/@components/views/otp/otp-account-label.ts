export function splitOTPAccountLabel(label: string): {
  provider: string;
  name: string;
} {
  const separator = label.indexOf(':');
  const provider = separator > 0 ? label.slice(0, separator).trim() : '';
  const name = provider ? label.slice(separator + 1).trim() || label : label;
  return {provider, name};
}
