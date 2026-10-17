import {UI_LOCALE} from './locale.js';

const relativeTimeFormat = new Intl.RelativeTimeFormat(UI_LOCALE, {
  numeric: 'auto',
});

const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

export function formatRelativeTime(value: number, now = Date.now()): string {
  const difference = value - now;
  const unit = units.find(([, duration]) => Math.abs(difference) >= duration);

  return unit
    ? relativeTimeFormat.format(Math.trunc(difference / unit[1]), unit[0])
    : relativeTimeFormat.format(0, 'second');
}
