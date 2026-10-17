import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {
  formatDecimal,
  formatScientificDecimal,
} from '../../@lib/format-decimal.js';

import {DetailsPopup} from './details-popup.js';
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

  &:is(button) {
    cursor: pointer;
  }
`;

const ZeroCount = styled.sub`
  position: relative;
  bottom: -0.2em;
  font-size: 0.75em;
  line-height: 0;
  vertical-align: baseline;
`;

export const FormattedNumberDetailsContent = styled(MessageContent)`
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: 16px;
  text-align: center;
`;

const Exponent = styled.sup`
  position: relative;
  top: -0.4em;
  font-size: 0.75em;
  line-height: 0;
  vertical-align: baseline;
`;

export const FormattedNumber = ({
  value,
  unit,
  significantDigits = 4,
  displayValue,
  displayValueColor,
  fullValue,
  interactive = true,
  onClick,
}: {
  value: string;
  unit?: string;
  significantDigits?: number;
  displayValue?: string;
  displayValueColor?: string;
  fullValue?: string;
  interactive?: boolean;
  onClick?: () => void;
}): ReactNode => {
  const [showDetails, setShowDetails] = useState(false);
  const formatted = formatDecimal(value, significantDigits);
  const scientific = formatScientificDecimal(formatted.value);
  const compact = /^(-?0\.)(0{4,})([1-9]\d*)$/.exec(formatted.value);
  const suffix = unit ? ` ${unit}` : '';

  return (
    <>
      <Value
        style={{
          color: displayValue !== undefined ? displayValueColor : undefined,
          fontSize: displayValue !== undefined ? '0.875em' : undefined,
        }}
        as={interactive ? 'button' : 'span'}
        type={interactive ? 'button' : undefined}
        aria-label={
          interactive
            ? `${displayValue ?? `${formatted.approximate ? 'Approximately ' : ''}${formatted.value}`}${suffix}`
            : undefined
        }
        aria-haspopup={interactive ? 'dialog' : undefined}
        onClick={
          interactive ? (onClick ?? (() => setShowDetails(true))) : undefined
        }
      >
        {!displayValue && formatted.approximate && '~'}
        {displayValue ??
          (scientific ? (
            <>
              {scientific.coefficient} × 10
              <Exponent>{scientific.exponent}</Exponent>
            </>
          ) : compact ? (
            <>
              {compact[1]}0<ZeroCount>{compact[2]!.length}</ZeroCount>
              {compact[3]}
            </>
          ) : (
            formatted.value
          ))}
        {suffix}
      </Value>
      {interactive && !onClick && showDetails && (
        <DetailsPopup
          aria-label="Full value"
          onDismiss={() => setShowDetails(false)}
        >
          <FormattedNumberDetailsContent>
            {fullValue ?? `${value}${suffix}`}
          </FormattedNumberDetailsContent>
        </DetailsPopup>
      )}
    </>
  );
};
