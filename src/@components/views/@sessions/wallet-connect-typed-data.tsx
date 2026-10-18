import {observer} from 'mobx-react-lite';
import {type ComponentProps, type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import type {EvmPermit} from '../../../@lib/evm-permit.js';
import type {EvmPermit2} from '../../../@lib/evm-permit2.js';
import type {EvmTypedData} from '../../../@lib/evm-typed-data.js';
import {formatSigningJSON} from '../../../@lib/format-signing-json.js';
import {getTypedDataFields} from '../../../@lib/typed-data-fields.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {EvmTokenTag} from '../../@ui/evm-token.js';
import {InfoSection} from '../../@ui/info-section.js';
import {
  MessageContent,
  MessageSectionHeader,
  MessageSectionTitle,
} from '../../@ui/message-content.js';
import {
  TypedDataFieldList,
  TypedDataFields,
} from '../../@ui/typed-data-fields.js';

import {WalletConnectPermit} from './wallet-connect-permit.js';
import {WalletConnectPermit2} from './wallet-connect-permit2.js';

const DomainContent = styled(MessageContent).attrs({as: 'div'})`
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
`;

export const WalletConnectTypedData = observer(function WalletConnectTypedData({
  data,
  permit,
  permit2,
  signer,
  ...addressProps
}: {
  data: EvmTypedData;
  permit?: EvmPermit;
  permit2?: EvmPermit2;
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
      {!token && !permit2 && (
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
        {permit2 ? (
          <MessageSectionTitle
            as="button"
            type="button"
            $emphasized
            aria-label="Permit2 signing domain"
            aria-haspopup="dialog"
            onClick={() => setShowDomain(true)}
          >
            Permit2
          </MessageSectionTitle>
        ) : (
          <MessageSectionHeader>
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
          </MessageSectionHeader>
        )}
        {permit ? (
          <WalletConnectPermit
            {...messageProps}
            permit={permit}
            token={token}
            signer={signer}
          />
        ) : permit2 ? (
          <WalletConnectPermit2 {...messageProps} permit={permit2} />
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
