import {requireValue, string} from './http.js';

export function groupName(value: unknown): string {
  const name = string(value, 128).normalize('NFC');
  requireValue(
    name.trim() === name &&
      !/[\p{Cc}\p{Cf}]/u.test(name) &&
      new TextEncoder().encode(name).length <= 128,
    'invalid_group_name',
  );
  return name;
}
