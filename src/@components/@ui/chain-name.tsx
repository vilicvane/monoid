import {IonIcon} from '@ionic/react';
import info from 'lucide-static/icons/info.svg';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {CenteredPopup} from './centered-popup.js';
import {
  InfoSectionHeader,
  InfoSectionItemLabel,
  InfoSectionRow,
  InfoSectionTitle,
} from './info-section.js';
import {inlineIconCSS} from './inline-icon.js';

const Value = styled.button`
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
`;

const DetailsIcon = styled(IonIcon)`
  ${inlineIconCSS}
  display: block;
  align-self: center;
`;

const Header = styled(InfoSectionHeader)`
  justify-content: flex-start;
  gap: 6px;
`;

const Logo = styled.img`
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: contain;
`;

const Identifier = styled.span`
  max-width: 100%;
  font-family:
    ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  overflow-wrap: anywhere;
  user-select: text;
`;

export const ChainValue = observer(
  ({chainId, className}: {chainId: string; className?: string}): ReactNode => {
    const {chainService} = useEntrances();
    const name = chainService.getChainName(chainId);
    const icon = chainService.getChainIcon(chainId);
    const identifier = chainId.slice(chainId.indexOf(':') + 1);
    const [showDetails, setShowDetails] = useState(false);
    const [failedIcon, setFailedIcon] = useState<string>();

    useEffect(() => {
      void chainService.refresh().catch(console.warn);
    }, [chainService]);

    return (
      <>
        <Value
          className={className}
          type="button"
          aria-haspopup="dialog"
          onClick={() => setShowDetails(true)}
        >
          <span>{name ?? identifier}</span>
          <DetailsIcon icon={info} aria-hidden="true" />
        </Value>
        {showDetails && (
          <CenteredPopup
            aria-label="Chain details"
            onDismiss={() => setShowDetails(false)}
          >
            <Header>
              <InfoSectionTitle>{name ?? 'Unknown network'}</InfoSectionTitle>
              {icon && icon !== failedIcon && (
                <Logo
                  src={icon}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={() => setFailedIcon(icon)}
                />
              )}
            </Header>
            <InfoSectionRow>
              <InfoSectionItemLabel>Chain ID</InfoSectionItemLabel>
              <Identifier>{identifier}</Identifier>
            </InfoSectionRow>
          </CenteredPopup>
        )}
      </>
    );
  },
);

export const ChainName = styled(ChainValue)`
  align-self: flex-start;
  font-size: 14px;
`;
