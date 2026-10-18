import {Coins as coins} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {AppIcon} from './app-icon.js';
import {DetailsPopupHeader, detailsPopupLogoCSS} from './details-popup.js';

function Logo({src, className}: {src?: string; className?: string}): ReactNode {
  const [failedLogo, setFailedLogo] = useState<string>();

  return src && src !== failedLogo ? (
    <img
      className={className}
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailedLogo(src)}
    />
  ) : (
    <AppIcon className={className} icon={coins} aria-hidden="true" />
  );
}

export const TokenLogo = styled(Logo)`
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: contain;
`;

export const TokenDetailsHeader = styled(DetailsPopupHeader)`
  > ${TokenLogo} {
    ${detailsPopupLogoCSS}
  }
`;
