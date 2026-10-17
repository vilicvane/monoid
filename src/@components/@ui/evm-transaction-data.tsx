import {observer} from 'mobx-react-lite';
import {type ComponentProps, type ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {EvmCalldata} from '../../@lib/evm-calldata.js';

import {CopyButton} from './copy-button.js';
import {EvmCalldataVerification} from './evm-calldata-verification.js';
import {InfoSection, InfoSectionHeader} from './info-section.js';
import {MessageContent, MessageSectionTitle} from './message-content.js';
import {TypedDataFieldList, type TypedDataFields} from './typed-data-fields.js';

type AddressProps = Pick<
  ComponentProps<typeof TypedDataFields>,
  'getAddressKind' | 'getAddressMark' | 'onAddressClick'
>;

const Call = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;

  & + & {
    margin-top: 12px;
  }
`;

const Header = styled(InfoSectionHeader)`
  > button:last-child {
    margin-right: 0;
  }
`;

const DataSize = styled(CopyButton)`
  font-size: 13px;
`;

const Note = styled.div`
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
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
  if (data === '0x') return null;

  return (
    <InfoSection aria-label="Transaction data">
      <Header>
        <MessageSectionTitle>Data</MessageSectionTitle>
        <DataSize value={data} label="Copy transaction data">
          {(data.length - 2) / 2} bytes
        </DataSize>
      </Header>
      <MessageContent as="div">
        {decoded ? (
          <DecodedCall chainId={chainId} decoded={decoded} {...addressProps} />
        ) : (
          <Call>
            <Note role="status">Decoding…</Note>
            <span>{data}</span>
          </Call>
        )}
      </MessageContent>
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
  const {evmCallHistoryService} = useEntrances();
  const canUseHistory =
    unambiguous && decoded.candidates.length === 1 && decoded.issue !== 'limit';

  return (
    <Call>
      {decoded.candidates.map(candidate => {
        const seen =
          canUseHistory && decoded.contractAddress
            ? evmCallHistoryService.hasSigned(
                chainId,
                decoded.contractAddress,
                candidate.signature,
              )
            : undefined;

        return (
          <Call key={candidate.signature}>
            <EvmCalldataVerification
              candidate={candidate}
              target={decoded.target}
              seen={seen}
            />
            <TypedDataFieldList
              {...addressProps}
              label={`${candidate.signature} arguments`}
              fields={candidate.fields}
              renderValue={(_field, path) => {
                const call = candidate.calls[path];
                return call ? (
                  <DecodedCall
                    chainId={chainId}
                    decoded={call}
                    unambiguous={canUseHistory}
                    {...addressProps}
                  />
                ) : undefined;
              }}
            />
          </Call>
        );
      })}
      {!decoded.candidates.length && <span>{decoded.data}</span>}
    </Call>
  );
});
