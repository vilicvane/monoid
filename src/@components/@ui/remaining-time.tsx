import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {UI_LOCALE} from '../../@lib/locale.js';

const units = (
  [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const
).map(([unit, seconds]) => ({
  seconds,
  format: new Intl.NumberFormat(UI_LOCALE, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
  }),
}));

const expiryFormat = new Intl.DateTimeFormat(UI_LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

const Time = styled.time`
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: normal;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`;

function getRemainingSeconds(value: number): number {
  return Math.max(0, Math.ceil((value - Date.now()) / 1000));
}

export function RemainingTime({value}: {value: number}): ReactNode {
  const [remaining, setRemaining] = useState(() => getRemainingSeconds(value));

  useEffect(() => {
    const seconds = getRemainingSeconds(value);
    setRemaining(seconds);
    if (!seconds) return;

    const timer = setInterval(() => {
      const seconds = getRemainingSeconds(value);
      setRemaining(seconds);
      if (!seconds) clearInterval(timer);
    }, 1000);

    return () => clearInterval(timer);
  }, [value]);

  const unit = units.find(unit => remaining >= unit.seconds);

  return (
    <Time
      dateTime={new Date(value).toISOString()}
      title={`Expires ${expiryFormat.format(value)}`}
    >
      {unit
        ? `${unit.format.format(Math.floor(remaining / unit.seconds))} left`
        : 'Expired'}
    </Time>
  );
}
