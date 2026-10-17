import {observer} from 'mobx-react-lite';
import {type ComponentProps, type ReactNode, useEffect} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {EvmCalldata} from '../../@lib/evm-calldata.js';
import {getErc20AmountIndex, getErc20CallTarget} from '../../@lib/evm-token.js';

import {CopyButton} from './copy-button.js';
import {EvmCalldataVerification} from './evm-calldata-verification.js';
import {EvmTokenAmount, EvmTokenTag} from './evm-token.js';
import {ExpandableText} from './expandable-text.js';
import {
  InfoSection,
  InfoSectionHeader,
  InfoSectionLoadingSpinner,
} from './info-section.js';
import {MessageContent, MessageSectionTitle} from './message-content.js';
import {TypedDataFieldList, type TypedDataFields} from './typed-data-fields.js';

type AddressProps = Pick<
  ComponentProps<typeof TypedDataFields>,
  'getAddressKind' | 'getAddressMark' | 'onAddressClick'
>;

const Call = styled.div<{$withToken?: boolean}>`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding-top: ${({$withToken}) => ($withToken ? '4px' : '0')};
`;

const CallToken = styled(EvmTokenTag)`
  margin-bottom: -2px;
`;

const Header = styled(InfoSectionHeader)`
  > button:last-child {
    margin-right: 0;
  }
`;

const DataSize = styled(CopyButton)`
  font-size: 13px;
`;

export function EvmTransactionData({
  chainId,
  data,
  decoded,
  ...addressProps
}: {
  chainId: string;
  data: string;
  decoded?: EvmCalldata;
} & AddressProps): ReactNode {
  const {evmTokenService} = useEntrances();
  useEffect(() => {
    void evmTokenService.refresh().catch(console.warn);
  }, [evmTokenService]);

  if (data === '0x') return null;

  return (
    <InfoSection aria-label="Transaction data">
      <Header>
        <MessageSectionTitle>Data</MessageSectionTitle>
        {decoded ? (
          <DataSize value={data} label="Copy transaction data">
            {(data.length - 2) / 2} bytes
          </DataSize>
        ) : (
          <InfoSectionLoadingSpinner aria-label="Decoding transaction data" />
        )}
      </Header>
      {decoded && (
        <MessageContent as="div">
          <DecodedCall chainId={chainId} decoded={decoded} {...addressProps} />
        </MessageContent>
      )}
    </InfoSection>
  );
}

const DecodedCall = observer(function DecodedCall({
  chainId,
  decoded,
  unambiguous = true,
  ...addressProps
}: {
  chainId: string;
  decoded: EvmCalldata;
  unambiguous?: boolean;
} & AddressProps): ReactNode {
  const {evmCallHistoryService, evmTokenService} = useEntrances();
  const unambiguousCall =
    unambiguous && decoded.candidates.length === 1 && decoded.issue !== 'limit';
  const tokenTarget = unambiguous ? getErc20CallTarget(decoded) : undefined;
  const token = tokenTarget
    ? evmTokenService.getToken(chainId, tokenTarget)
    : undefined;

  useEffect(() => {
    if (tokenTarget) void evmTokenService.resolve(chainId, tokenTarget);
  }, [evmTokenService, chainId, tokenTarget]);

  return (
    <Call>
      {decoded.candidates.map(candidate => {
        // Use the called token (the proxy address when applicable), not its implementation.
        const amountIndex = getErc20AmountIndex(candidate.signature);
        const seen =
          unambiguousCall && decoded.contractAddress
            ? evmCallHistoryService.hasSigned(
                chainId,
                decoded.contractAddress,
                candidate.signature,
              )
            : undefined;

        return (
          <Call key={candidate.signature} $withToken={!!token}>
            {token && (
              <CallToken
                token={token}
                kind={addressProps.getAddressKind?.(token.address) ?? 'unknown'}
              />
            )}
            <EvmCalldataVerification
              candidate={candidate}
              target={decoded.target}
              seen={seen}
            />
            <TypedDataFieldList
              {...addressProps}
              label={`${candidate.signature} arguments`}
              fields={candidate.fields}
              renderValue={(field, path) => {
                if (
                  token &&
                  token.decimals !== undefined &&
                  path === String(amountIndex) &&
                  field.kind === 'value' &&
                  field.type === 'uint256'
                ) {
                  return {
                    content: (
                      <EvmTokenAmount
                        maximumAsUnlimited={
                          candidate.signature === 'approve(address,uint256)'
                        }
                        token={token}
                        value={BigInt(field.value)}
                      />
                    ),
                  };
                }
                const call = candidate.calls[path];
                return call
                  ? {
                      block: true,
                      content: (
                        <DecodedCall
                          chainId={chainId}
                          decoded={call}
                          unambiguous={unambiguousCall}
                          {...addressProps}
                        />
                      ),
                    }
                  : undefined;
              }}
            />
          </Call>
        );
      })}
      {!decoded.candidates.length && (
        <ExpandableText key={decoded.data}>{decoded.data}</ExpandableText>
      )}
    </Call>
  );
});
