import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {FEATURE_VISUALS} from '../../@features.js';
import {TypewriterText} from '../../@ui/typewriter-text.js';

const KEYWORDS = ['WalletConnect', 'OTP'] as const;
const COLORS = [FEATURE_VISUALS.sessions.color, FEATURE_VISUALS.otp.color];

const Keyword = styled.strong`
  font-weight: 500;
`;

export function QrScanInstructions({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}): ReactNode {
  return (
    <Keyword className={className} aria-hidden={!active}>
      <TypewriterText
        texts={KEYWORDS}
        active={active}
        fallback={
          <>
            <span style={{color: COLORS[0]}}>{KEYWORDS[0]}</span>
            {' / '}
            <span style={{color: COLORS[1]}}>{KEYWORDS[1]}</span>
          </>
        }
      >
        {(keyword, index) => (
          <span style={{color: COLORS[index]}}>{keyword}</span>
        )}
      </TypewriterText>
    </Keyword>
  );
}
