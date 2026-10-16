export function formatSigningJSON(value: object | string): string {
  // JSON escapes control characters, but leaves invisible formatting controls
  // such as bidi overrides intact. Show those without changing signed values.
  return JSON.stringify(value, null, 2).replace(/\p{Cf}/gu, character =>
    character
      .split('')
      .map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}
