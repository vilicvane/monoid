import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {formatDecimal} from '../../@lib/format-decimal.js';

import {CenteredPopup} from './centered-popup.js';
import {MessageContent} from './message-content.js';

const Value = styled.button`
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: inherit;
  overflow-wrap: anywhere;
  cursor: pointer;
`;

const ZeroCount = styled.sub`
  position: relative;
  bottom: -0.2em;
  font-size: 0.75em;
  line-height: 0;
  vertical-align: baseline;
`;

const FullValue = styled(MessageContent)`
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: 16px;
  text-align: center;
`;

export const FormattedNumber = ({
  value,
  unit,
  significantDigits = 4,
}: {
  value: string;
  unit?: string;
  significantDigits?: number;
}): ReactNode => {
  const [showDetails, setShowDetails] = useState(false);
  const formatted = formatDecimal(value, significantDigits);
  const compact = /^(-?0\.)(0{4,})([1-9]\d*)$/.exec(formatted.value);
  const suffix = unit ? ` ${unit}` : '';

  return (
    <>
      <Value
        type="button"
        aria-label={`${formatted.approximate ? 'Approximately ' : ''}${formatted.value}${suffix}`}
        aria-haspopup="dialog"
        onClick={() => setShowDetails(true)}
      >
        {formatted.approximate && '~'}
        {compact ? (
          <>
            {compact[1]}0<ZeroCount>{compact[2]!.length}</ZeroCount>
            {compact[3]}
          </>
        ) : (
          formatted.value
        )}
        {suffix}
      </Value>
      {showDetails && (
        <CenteredPopup
          aria-label="Full value"
          onDismiss={() => setShowDetails(false)}
        >
          <FullValue>
            {value}
            {suffix}
          </FullValue>
        </CenteredPopup>
      )}
    </>
  );
};
