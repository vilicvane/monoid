import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {formatRelativeTime} from '../../@lib/format-relative-time.js';
import {UI_LOCALE} from '../../@lib/locale.js';

import {DetailsPopup, DetailsPopupDivider} from './details-popup.js';
import {InfoSectionItemLabel, InfoSectionRow} from './info-section.js';

const dateTimeFormat = new Intl.DateTimeFormat(UI_LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat(UI_LOCALE, {timeStyle: 'short'});
const dayFormat = new Intl.DateTimeFormat(UI_LOCALE, {
  month: 'short',
  day: 'numeric',
});
const dateFormat = new Intl.DateTimeFormat(UI_LOCALE, {dateStyle: 'short'});

const preciseDateFormat = new Intl.DateTimeFormat(UI_LOCALE, {
  dateStyle: 'long',
});
const preciseTimeFormat = new Intl.DateTimeFormat(UI_LOCALE, {
  timeStyle: 'long',
});

const TimeButton = styled.button`
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: inherit;
`;

const FullDateTime = styled.time`
  line-height: 1.5;
  text-align: center;
  user-select: text;
`;

export function DateTime({
  value,
  compact = false,
  relative = false,
}: {
  value: number;
  compact?: boolean;
  relative?: boolean;
}): ReactNode {
  const [currentTime, setCurrentTime] = useState(Date.now);

  useEffect(() => {
    if (!relative) return;

    const timer = setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [relative]);

  const date = new Date(value);
  const now = new Date();
  const format =
    date.toDateString() === now.toDateString()
      ? timeFormat
      : date.getFullYear() === now.getFullYear()
        ? dayFormat
        : dateFormat;

  return (
    <time dateTime={date.toISOString()} title={dateTimeFormat.format(value)}>
      {relative
        ? formatRelativeTime(value, currentTime)
        : compact
          ? format.format(value)
          : dateTimeFormat.format(value)}
    </time>
  );
}

export function PopupDateTime({
  value,
  showTimestamp = false,
}: {
  value: number;
  showTimestamp?: boolean;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <>
      <TimeButton
        type="button"
        aria-label="Show exact time"
        aria-haspopup="dialog"
        onClick={() => setShowDetails(true)}
      >
        <DateTime value={value} relative />
      </TimeButton>
      {showDetails && (
        <DetailsPopup
          aria-label="Date and time"
          onDismiss={() => setShowDetails(false)}
        >
          <FullDateTime dateTime={new Date(value).toISOString()}>
            {preciseDateFormat.format(value)}
            <br />
            {preciseTimeFormat.format(value)}
          </FullDateTime>
          {showTimestamp && (
            <>
              <DetailsPopupDivider />
              <InfoSectionRow>
                <InfoSectionItemLabel>Unix seconds</InfoSectionItemLabel>
                <span>{Math.floor(value / 1000)}</span>
              </InfoSectionRow>
            </>
          )}
        </DetailsPopup>
      )}
    </>
  );
}
