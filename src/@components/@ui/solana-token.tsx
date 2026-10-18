import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';

import {useEntrances} from '../../@entrances.js';
import {formatTokenAmount} from '../../@lib/format-decimal.js';
import type {SolanaTokenReview} from '../../@lib/solana-token-review.js';

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

export const SolanaTokenTag = observer(function SolanaTokenTag({
  chainId,
  token,
}: {
  chainId: string;
  token: SolanaTokenReview & {mint: string};
}): ReactNode {
  const {solanaTokenService, chainService} = useEntrances();
  const [showDetails, setShowDetails] = useState(false);
  const candidate = solanaTokenService.getToken(chainId, token.mint);
  const metadata =
    candidate &&
    (token.decimals === undefined || candidate.decimals === token.decimals)
      ? candidate
      : undefined;
  const name =
    metadata?.name ?? `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`;

  return (
    <>
      <IconTag
        as="button"
        type="button"
        aria-label="Token details"
        aria-haspopup="dialog"
        onClick={() => setShowDetails(true)}
      >
        <TokenLogo src={metadata?.logoURI} />
        <IconTagName>{name}</IconTagName>
      </IconTag>
      {showDetails && (
        <DetailsPopup
          aria-label="Token details"
          onDismiss={() => setShowDetails(false)}
        >
          <TokenDetailsHeader>
            <TokenLogo src={metadata?.logoURI} />
            <DetailsPopupTitle>
              {metadata?.name ?? 'SPL Token'}
            </DetailsPopupTitle>
          </TokenDetailsHeader>
          <CenteredPopupAddress>{token.mint}</CenteredPopupAddress>
          <DetailsPopupDivider />
          {metadata && (
            <InfoSectionRow>
              <InfoSectionItemLabel>Symbol</InfoSectionItemLabel>
              <span>{metadata.symbol}</span>
            </InfoSectionRow>
          )}
          <InfoSectionRow>
            <InfoSectionItemLabel>Network</InfoSectionItemLabel>
            <span>{chainService.getChainName(chainId) ?? chainId}</span>
          </InfoSectionRow>
          <InfoSectionRow>
            <InfoSectionItemLabel>Decimals</InfoSectionItemLabel>
            <span>{token.decimals ?? 'Unknown'}</span>
          </InfoSectionRow>
          {metadata && (
            <InfoSectionRow>
              <InfoSectionItemLabel>Metadata source</InfoSectionItemLabel>
              <span>Jupiter</span>
            </InfoSectionRow>
          )}
        </DetailsPopup>
      )}
    </>
  );
});

export const SolanaTokenAmount = observer(function SolanaTokenAmount({
  chainId,
  token,
  value,
}: {
  chainId: string;
  token?: SolanaTokenReview;
  value: bigint;
}): ReactNode {
  const {solanaTokenService} = useEntrances();
  const metadata = token?.mint
    ? solanaTokenService.getToken(chainId, token.mint)
    : undefined;
  const decimals = token?.decimals;

  return (
    <FormattedNumber
      value={
        decimals === undefined
          ? value.toString()
          : formatTokenAmount(value, decimals)
      }
      unit={
        decimals === undefined
          ? 'base units'
          : metadata?.decimals === decimals
            ? metadata.symbol
            : 'tokens'
      }
      fullValue={value.toString()}
      decimals={decimals}
    />
  );
});
