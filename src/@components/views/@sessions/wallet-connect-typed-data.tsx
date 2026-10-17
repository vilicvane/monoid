import {observer} from 'mobx-react-lite';
import {type ComponentProps, type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import type {EvmPermit} from '../../../@lib/evm-permit.js';
import type {EvmTypedData} from '../../../@lib/evm-typed-data.js';
import {formatSigningJSON} from '../../../@lib/format-signing-json.js';
import {getTypedDataFields} from '../../../@lib/typed-data-fields.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {EvmTokenTag} from '../../@ui/evm-token.js';
import {InfoSection, InfoSectionHeader} from '../../@ui/info-section.js';
import {
  MessageContent,
  MessageSectionTitle,
} from '../../@ui/message-content.js';
import {
  TypedDataFieldList,
  TypedDataFields,
} from '../../@ui/typed-data-fields.js';

import {WalletConnectPermit} from './wallet-connect-permit.js';

const MessageHeader = styled(InfoSectionHeader)`
  > button:last-child {
    margin: 0;
  }
`;

const DomainContent = styled(MessageContent).attrs({as: 'div'})`
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
`;

export const WalletConnectTypedData = observer(function WalletConnectTypedData({
  data,
  permit,
  signer,
  ...addressProps
}: {
  data: EvmTypedData;
  permit?: EvmPermit;
  signer: string;
} & Pick<
  ComponentProps<typeof TypedDataFields>,
  'getAddressKind' | 'getAddressMark' | 'onAddressClick'
>): ReactNode {
  const {evmTokenService} = useEntrances();
  const [showDomain, setShowDomain] = useState(false);
  const token = permit
    ? evmTokenService.getToken(permit.chainId, permit.token)
    : undefined;
  const domainFields = getTypedDataFields(
    data.types,
    'EIP712Domain',
    data.domain,
  );
  const messageProps = {
    ...addressProps,
    label: data.primaryType,
    fields: getTypedDataFields(data.types, data.primaryType, data.message),
  };

  useEffect(() => {
    if (!permit) return;
    void evmTokenService.refresh().catch(console.warn);
    void evmTokenService.resolve(permit.chainId, permit.token);
  }, [evmTokenService, permit]);

  return (
    <>
      {!token && (
        <InfoSection>
          <MessageSectionTitle>Domain</MessageSectionTitle>
          <TypedDataFields
            {...addressProps}
            label="Signing domain"
            fields={domainFields}
          />
        </InfoSection>
      )}
      <InfoSection>
        <MessageHeader>
          <MessageSectionTitle $emphasized={!!permit}>
            {formatSigningJSON(data.primaryType).slice(1, -1)}
          </MessageSectionTitle>
          {token && (
            <EvmTokenTag
              token={token}
              kind={addressProps.getAddressKind?.(token.address) ?? 'unknown'}
              aria-label={`${token.symbol} signing domain`}
              onClick={() => setShowDomain(true)}
            />
          )}
        </MessageHeader>
        {permit ? (
          <WalletConnectPermit
            {...messageProps}
            permit={permit}
            token={token}
            signer={signer}
          />
        ) : (
          <TypedDataFields {...messageProps} />
        )}
      </InfoSection>
      {showDomain && (
        <DetailsPopup
          aria-label="Signing domain"
          onDismiss={() => setShowDomain(false)}
        >
          <DetailsPopupTitle>Domain</DetailsPopupTitle>
          <DetailsPopupDivider />
          <DomainContent>
            <TypedDataFieldList
              fields={domainFields}
              getAddressKind={addressProps.getAddressKind}
              getAddressMark={addressProps.getAddressMark}
              renderValue={field =>
                field.kind === 'value' && field.name === 'chainId'
                  ? {content: BigInt(field.value).toString()}
                  : undefined
              }
            />
          </DomainContent>
        </DetailsPopup>
      )}
    </>
  );
});
