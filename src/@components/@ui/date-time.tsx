import type {ReactNode} from 'react';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const timeFormat = new Intl.DateTimeFormat(undefined, {timeStyle: 'short'});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const dateFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'short'});

export function DateTime({
  value,
  compact = false,
}: {
  value: number;
  compact?: boolean;
}): ReactNode {
  const date = new Date(value);
  const now = new Date();
  const format = !compact
    ? dateTimeFormat
    : date.toDateString() === now.toDateString()
      ? timeFormat
      : date.getFullYear() === now.getFullYear()
        ? dayFormat
        : dateFormat;

  return (
    <time dateTime={date.toISOString()} title={dateTimeFormat.format(value)}>
      {format.format(value)}
    </time>
  );
}
