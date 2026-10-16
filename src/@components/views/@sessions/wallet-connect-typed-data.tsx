import type {ComponentProps, ReactNode} from 'react';

import type {EvmTypedData} from '../../../@lib/evm-typed-data.js';
import {formatSigningJSON} from '../../../@lib/format-signing-json.js';
import {getTypedDataFields} from '../../../@lib/typed-data-fields.js';
import {InfoSection} from '../../@ui/info-section.js';
import {MessageSectionTitle} from '../../@ui/message-content.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';

export function WalletConnectTypedData({
  data,
  ...addressProps
}: {
  data: EvmTypedData;
} & Pick<
  ComponentProps<typeof TypedDataFields>,
  'getAddressKind' | 'getAddressMark' | 'onAddressClick'
>): ReactNode {
  return (
    <>
      <InfoSection>
        <MessageSectionTitle>Domain</MessageSectionTitle>
        <TypedDataFields
          {...addressProps}
          label="Signing domain"
          fields={getTypedDataFields(data.types, 'EIP712Domain', data.domain)}
        />
      </InfoSection>
      <InfoSection>
        <MessageSectionTitle>
          {formatSigningJSON(data.primaryType).slice(1, -1)}
        </MessageSectionTitle>
        <TypedDataFields
          {...addressProps}
          label={data.primaryType}
          fields={getTypedDataFields(
            data.types,
            data.primaryType,
            data.message,
          )}
        />
      </InfoSection>
    </>
  );
}
