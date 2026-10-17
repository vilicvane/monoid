import {IonIcon} from '@ionic/react';
import coins from 'lucide-static/icons/coins.svg';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {
  type AddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import {
  type EvmToken,
  formatTokenAmount,
  getEvmTokenAddressKind,
} from '../../@lib/evm-token.js';

import {AddressMarkControl} from './address-mark-control.js';
import {AddressMarker} from './address-marker.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupHeader,
  DetailsPopupTitle,
  detailsPopupLogoCSS,
} from './details-popup.js';
import {FormattedNumber} from './formatted-number.js';
import {IconTag, IconTagName} from './icon-tag.js';
import {InfoSectionItemLabel, InfoSectionRow} from './info-section.js';
import {PopupAddress} from './popup-address.js';

const Logo = styled.img`
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: contain;
`;

const DetailsHeader = styled(DetailsPopupHeader)`
  > ${Logo} {
    ${detailsPopupLogoCSS}
  }
`;

const RawAmount = styled.span`
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family:
    ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
`;

const Name = styled.span<{$severity?: 'warning' | 'danger'}>`
  color: ${({$severity}) =>
    $severity ? `var(--color-address-${$severity})` : 'inherit'};
`;

export const EvmTokenTag = observer(function EvmTokenTag({
  token,
  kind,
  className,
}: {
  token: EvmToken;
  kind: AddressKind;
  className?: string;
}): ReactNode {
  const {chainService, evmTokenService, addressBookService} = useEntrances();
  const mark = addressBookService.getMark('evm', token.address);
  const listed = evmTokenService.isListed(
    `eip155:${token.chainId}`,
    token.address,
  );
  const tokenKind = getEvmTokenAddressKind(kind, listed);
  const marker =
    tokenKind === 'listed' && !mark ? undefined : (
      <AddressMarker kind={tokenKind} mark={mark} />
    );
  const name = (
    <IconTagName suffix={marker}>
      <Name $severity={getAddressSeverity(tokenKind, mark)}>{token.name}</Name>
    </IconTagName>
  );
  const [showDetails, setShowDetails] = useState(false);
  const [failedLogo, setFailedLogo] = useState<string>();
  const logo =
    token.logoURI && token.logoURI !== failedLogo ? (
      <Logo
        src={token.logoURI}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailedLogo(token.logoURI)}
      />
    ) : (
      <Logo as={IonIcon} icon={coins} aria-hidden="true" />
    );

  return (
    <>
      <IconTag
        as="button"
        type="button"
        className={className}
        aria-label={`${token.symbol} token details`}
        aria-haspopup="dialog"
        onClick={() => setShowDetails(true)}
      >
        {logo}
        {name}
      </IconTag>
      {showDetails && (
        <DetailsPopup
          aria-label="Token details"
          onDismiss={() => setShowDetails(false)}
        >
          <DetailsHeader>
            {logo}
            <DetailsPopupTitle>
              <Name $severity={getAddressSeverity(tokenKind, mark)}>
                {token.name}
              </Name>
            </DetailsPopupTitle>
            {marker}
          </DetailsHeader>
          <PopupAddress>{token.address}</PopupAddress>
          <DetailsPopupDivider />
          <InfoSectionRow>
            <InfoSectionItemLabel>Symbol</InfoSectionItemLabel>
            <span>{token.symbol}</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Network</InfoSectionItemLabel>
            <span>
              {chainService.getChainName(`eip155:${token.chainId}`) ??
                'Unknown network'}
            </span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Chain ID</InfoSectionItemLabel>
            <span>{token.chainId}</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Decimals</InfoSectionItemLabel>
            <span>{token.decimals ?? 'Unknown'}</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Metadata source</InfoSectionItemLabel>
            <span>{listed ? 'Uniswap token list' : 'Contract'}</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Seen in signed messages</InfoSectionItemLabel>
            <span>
              {addressBookService.hasSigned('evm', token.address)
                ? 'Yes'
                : 'No'}
            </span>
          </InfoSectionRow>
          <AddressMarkControl address={token.address} />
        </DetailsPopup>
      )}
    </>
  );
});

export function EvmTokenAmount({
  token,
  value,
}: {
  token: EvmToken;
  value: bigint;
}): ReactNode {
  if (token.decimals === undefined) return value.toString();
  return (
    <FormattedNumber
      value={formatTokenAmount(value, token.decimals)}
      unit={token.symbol}
      details={
        <InfoSectionRow>
          <InfoSectionItemLabel>Raw amount</InfoSectionItemLabel>
          <RawAmount>{value.toString()}</RawAmount>
        </InfoSectionRow>
      }
    />
  );
}
