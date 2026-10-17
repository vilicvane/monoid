import {IonIcon} from '@ionic/react';
import info from 'lucide-static/icons/info.svg';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {ChainIcon} from './chain-icon.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupHeader,
  DetailsPopupTitle,
  detailsPopupLogoCSS,
} from './details-popup.js';
import {IconTagName, iconTagCSS} from './icon-tag.js';
import {InfoSectionItemLabel, InfoSectionRow} from './info-section.js';
import {inlineIconCSS} from './inline-icon.js';

const Value = styled.button<{$tag?: boolean}>`
  display: flex;
  align-items: baseline;
  gap: 4px;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  user-select: text;

  > span {
    min-width: 0;
  }

  ${({$tag}) => $tag && iconTagCSS}
`;

const DetailsIcon = styled(IonIcon)`
  ${inlineIconCSS}
  display: block;
  align-self: center;
`;

const HeaderIcon = styled(ChainIcon)`
  ${detailsPopupLogoCSS}
`;

const Identifier = styled.span`
  max-width: 100%;
  font-family:
    ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  overflow-wrap: anywhere;
  user-select: text;
`;

export const ChainValue = observer(
  ({
    chainId,
    className,
    appearance = 'text',
  }: {
    chainId: string;
    className?: string;
    appearance?: 'text' | 'tag';
  }): ReactNode => {
    const {chainService} = useEntrances();
    const name = chainService.getChainName(chainId);
    const identifier = chainId.slice(chainId.indexOf(':') + 1);
    const [showDetails, setShowDetails] = useState(false);

    useEffect(() => {
      void chainService.refresh().catch(console.warn);
    }, [chainService]);

    return (
      <>
        <Value
          $tag={appearance === 'tag'}
          className={className}
          type="button"
          aria-haspopup="dialog"
          onClick={() => setShowDetails(true)}
        >
          {appearance === 'tag' ? (
            <>
              <ChainIcon chainId={chainId} />
              <IconTagName>{name ?? identifier}</IconTagName>
            </>
          ) : (
            <>
              <span>{name ?? identifier}</span>
              <DetailsIcon icon={info} aria-hidden="true" />
            </>
          )}
        </Value>
        {showDetails && (
          <DetailsPopup
            aria-label="Chain details"
            onDismiss={() => setShowDetails(false)}
          >
            <DetailsPopupHeader>
              <HeaderIcon chainId={chainId} />
              <DetailsPopupTitle>{name ?? 'Unknown network'}</DetailsPopupTitle>
            </DetailsPopupHeader>
            <DetailsPopupDivider />
            <InfoSectionRow>
              <InfoSectionItemLabel>Chain ID</InfoSectionItemLabel>
              <Identifier>{identifier}</Identifier>
            </InfoSectionRow>
          </DetailsPopup>
        )}
      </>
    );
  },
);

export const ChainTag = ({
  chainId,
  className,
}: {
  chainId: string;
  className?: string;
}): ReactNode => (
  <ChainValue chainId={chainId} className={className} appearance="tag" />
);
