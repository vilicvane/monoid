import {MaxUint256} from 'ethers';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {
  type AddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import {type EvmToken, getEvmTokenAddressKind} from '../../@lib/evm-token.js';
import {formatTokenAmount} from '../../@lib/format-decimal.js';

import {AddressMarkControl} from './address-mark-control.js';
import {AddressMarker} from './address-marker.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from './details-popup.js';
import {FormattedNumber} from './formatted-number.js';
import {IconTag, IconTagName} from './icon-tag.js';
import {InfoSectionItemLabel, InfoSectionRow} from './info-section.js';
import {CenteredPopupAddress} from './popup-address.js';
import {TokenDetailsHeader, TokenLogo} from './token-logo.js';

const Title = styled(DetailsPopupTitle)<{$color?: string}>`
  color: ${({$color}) => $color ?? 'inherit'};
`;

const Label = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: 16px;
  text-align: left;

  > ${TokenLogo} {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
  }
`;

const LabelName = styled(Title).attrs({as: 'span'})`
  font: inherit;
  text-align: inherit;
`;

const TokenIdentity = observer(function TokenIdentity({
  token,
  kind,
  variant = 'tag',
}: {
  token: EvmToken;
  kind: AddressKind;
  variant?: 'tag' | 'label' | 'details';
}): ReactNode {
  const {evmTokenService, addressBookService} = useEntrances();
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
  const severity = getAddressSeverity(tokenKind, mark);
  const color = severity ? `var(--color-address-${severity})` : undefined;

  return variant === 'label' ? (
    <>
      <TokenLogo src={token.logoURI} />
      <LabelName $color={color}>{token.name}</LabelName>
      {marker}
    </>
  ) : variant === 'details' ? (
    <TokenDetailsHeader>
      <TokenLogo src={token.logoURI} />
      <Title $color={color}>{token.name}</Title>
      {marker}
    </TokenDetailsHeader>
  ) : (
    <>
      <TokenLogo src={token.logoURI} />
      <IconTagName suffix={marker} color={color}>
        {token.name}
      </IconTagName>
    </>
  );
});

export function EvmTokenLabel({
  token,
  kind,
  className,
  interactive = true,
}: {
  token: EvmToken;
  kind: AddressKind;
  className?: string;
  interactive?: boolean;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <>
      <Label
        as={interactive ? 'button' : 'span'}
        type={interactive ? 'button' : undefined}
        className={className}
        aria-label={interactive ? `${token.symbol} token details` : undefined}
        aria-haspopup={interactive ? 'dialog' : undefined}
        onClick={interactive ? () => setShowDetails(true) : undefined}
      >
        <TokenIdentity token={token} kind={kind} variant="label" />
      </Label>
      {interactive && showDetails && (
        <DetailsPopup
          aria-label="Token details"
          onDismiss={() => setShowDetails(false)}
        >
          <EvmTokenDetailsContent token={token} kind={kind} />
        </DetailsPopup>
      )}
    </>
  );
}

export function EvmTokenTag({
  token,
  kind,
  className,
  interactive = true,
  onClick,
  'aria-label': ariaLabel,
}: {
  token: EvmToken;
  kind: AddressKind;
  className?: string;
  interactive?: boolean;
  onClick?: () => void;
  'aria-label'?: string;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <>
      <IconTag
        as={interactive ? 'button' : 'span'}
        type={interactive ? 'button' : undefined}
        className={className}
        aria-label={
          interactive
            ? (ariaLabel ?? `${token.symbol} token details`)
            : undefined
        }
        aria-haspopup={interactive ? 'dialog' : undefined}
        onClick={
          interactive ? (onClick ?? (() => setShowDetails(true))) : undefined
        }
      >
        <TokenIdentity token={token} kind={kind} />
      </IconTag>
      {interactive && !onClick && showDetails && (
        <DetailsPopup
          aria-label="Token details"
          onDismiss={() => setShowDetails(false)}
        >
          <EvmTokenDetailsContent token={token} kind={kind} />
        </DetailsPopup>
      )}
    </>
  );
}

export const EvmTokenDetailsContent = observer(function EvmTokenDetailsContent({
  token,
  kind,
}: {
  token: EvmToken;
  kind: AddressKind;
}): ReactNode {
  const {chainService, evmTokenService, addressBookService} = useEntrances();
  const listed = evmTokenService.isListed(
    `eip155:${token.chainId}`,
    token.address,
  );

  return (
    <>
      <TokenIdentity token={token} kind={kind} variant="details" />
      <CenteredPopupAddress>{token.address}</CenteredPopupAddress>
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
          {addressBookService.hasSigned('evm', token.address) ? 'Yes' : 'No'}
        </span>
      </InfoSectionRow>
      <AddressMarkControl address={token.address} />
    </>
  );
});

export function EvmTokenAmount({
  token,
  value,
  showSymbol = true,
  interactive = true,
  maximumAsUnlimited = false,
  maximum = MaxUint256,
  zeroAsRevoked = false,
  onClick,
}: {
  token: EvmToken;
  value: bigint;
  showSymbol?: boolean;
  interactive?: boolean;
  maximumAsUnlimited?: boolean;
  maximum?: bigint;
  zeroAsRevoked?: boolean;
  onClick?: () => void;
}): ReactNode {
  const revoked = zeroAsRevoked && value === BigInt(0);
  const displayValue = revoked
    ? 'Revoked'
    : maximumAsUnlimited && value === maximum
      ? 'Unlimited'
      : undefined;

  return (
    <FormattedNumber
      displayValue={displayValue}
      displayValueColor={revoked ? undefined : 'var(--color-address-warning)'}
      interactive={interactive}
      value={
        token.decimals === undefined
          ? value.toString()
          : formatTokenAmount(value, token.decimals)
      }
      unit={
        token.decimals === undefined && !displayValue
          ? 'base units'
          : showSymbol
            ? token.symbol
            : undefined
      }
      fullValue={value.toString()}
      decimals={token.decimals}
      onClick={onClick}
    />
  );
}
