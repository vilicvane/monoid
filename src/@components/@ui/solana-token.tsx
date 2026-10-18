import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';

import {useEntrances} from '../../@entrances.js';
import {formatTokenAmount} from '../../@lib/format-decimal.js';
import {SOLANA_TOKEN_PROGRAM} from '../../@lib/solana-token-instruction.js';
import type {SolanaTokenMetadata} from '../../@services/index.js';

import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from './details-popup.js';
import {FormattedNumber} from './formatted-number.js';
import {IconTag, IconTagName} from './icon-tag.js';
import {InfoSectionItemLabel, InfoSectionRow} from './info-section.js';
import {CenteredPopupAddress} from './popup-address.js';
import {TokenLabel, TokenLabelName} from './token-label.js';
import {TokenDetailsHeader, TokenLogo} from './token-logo.js';

export type SolanaToken = {
  mint: string;
  decimals?: number;
  programId?: string;
};

function useTokenMetadata(
  chainId: string,
  token?: Partial<SolanaToken>,
): SolanaTokenMetadata | undefined {
  const {solanaTokenService} = useEntrances();
  const candidate = token?.mint
    ? solanaTokenService.getToken(chainId, token.mint)
    : undefined;

  return candidate &&
    (!token?.programId || token.programId === SOLANA_TOKEN_PROGRAM) &&
    (token?.decimals === undefined || candidate.decimals === token.decimals)
    ? candidate
    : undefined;
}

export const SolanaTokenTag = observer(function SolanaTokenTag({
  chainId,
  token,
  className,
  appearance = 'tag',
  onClick,
}: {
  chainId: string;
  token: SolanaToken;
  className?: string;
  appearance?: 'tag' | 'label';
  onClick?: () => void;
}): ReactNode {
  const [showDetails, setShowDetails] = useState(false);
  const metadata = useTokenMetadata(chainId, token);
  const name =
    metadata?.name ?? `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`;
  const Container = appearance === 'label' ? TokenLabel : IconTag;

  return (
    <>
      <Container
        as="button"
        type="button"
        className={className}
        aria-label="Token details"
        aria-haspopup="dialog"
        onClick={onClick ?? (() => setShowDetails(true))}
      >
        <TokenLogo src={metadata?.logoURI} />
        {appearance === 'label' ? (
          <TokenLabelName>{name}</TokenLabelName>
        ) : (
          <IconTagName>{name}</IconTagName>
        )}
      </Container>
      {!onClick && showDetails && (
        <DetailsPopup
          aria-label="Token details"
          onDismiss={() => setShowDetails(false)}
        >
          <SolanaTokenDetailsContent chainId={chainId} token={token} />
        </DetailsPopup>
      )}
    </>
  );
});

export const SolanaTokenDetailsContent = observer(
  function SolanaTokenDetailsContent({
    chainId,
    token,
    onAddressClick,
  }: {
    chainId: string;
    token: SolanaToken;
    onAddressClick?: () => void;
  }): ReactNode {
    const {chainService} = useEntrances();
    const metadata = useTokenMetadata(chainId, token);

    return (
      <>
        <TokenDetailsHeader>
          <TokenLogo src={metadata?.logoURI} />
          <DetailsPopupTitle>{metadata?.name ?? 'SPL Token'}</DetailsPopupTitle>
        </TokenDetailsHeader>
        <CenteredPopupAddress onClick={onAddressClick}>
          {token.mint}
        </CenteredPopupAddress>
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
      </>
    );
  },
);

export const SolanaTokenAmount = observer(function SolanaTokenAmount({
  chainId,
  token,
  value,
  showSymbol = true,
  interactive = true,
  onClick,
}: {
  chainId: string;
  token?: Partial<SolanaToken>;
  value: bigint;
  showSymbol?: boolean;
  interactive?: boolean;
  onClick?: () => void;
}): ReactNode {
  const metadata = useTokenMetadata(chainId, token);
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
          : showSymbol
            ? (metadata?.symbol ?? 'tokens')
            : undefined
      }
      fullValue={value.toString()}
      decimals={decimals}
      interactive={interactive}
      onClick={onClick}
    />
  );
});
