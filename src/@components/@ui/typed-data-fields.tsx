import {getAddress} from 'ethers';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {AddressKind} from '../../@lib/address-status.js';
import {formatSigningJSON} from '../../@lib/format-signing-json.js';
import type {TypedDataFieldValue} from '../../@lib/typed-data-fields.js';
import type {AddressMark} from '../../@services/index.js';

import {ChainValue} from './chain-name.js';
import {ExpandableAddress} from './expandable-address.js';
import {InfoSectionRow} from './info-section.js';
import {MessageContent} from './message-content.js';

const Fields = styled.dl`
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Field = styled(InfoSectionRow)`
  gap: 2px 0;
  font-size: inherit;

  > :last-child {
    margin-left: 0;
    text-align: left;
  }
`;

const FieldHeader = styled.dt`
  max-width: 100%;
  color: var(--color-text-secondary);
`;

const FieldValue = styled.dd<{$block: boolean}>`
  width: ${({$block}) => ($block ? '100%' : 'max-content')};
  max-width: 100%;
  min-height: 1.5em;
  margin: 0;
  padding-left: 2ch;

  > ${Fields} {
    margin-top: 2px;
  }
`;

export function TypedDataFields({
  fields,
  label,
  getAddressKind,
  getAddressMark,
  onAddressClick,
}: {
  fields: TypedDataFieldValue[];
  label: string;
  getAddressKind?: (address: string) => AddressKind;
  getAddressMark?: (address: string) => AddressMark | undefined;
  onAddressClick?: (address: string) => void;
}): ReactNode {
  return (
    <MessageContent as="div" aria-label={label}>
      {fields.length ? (
        <FieldList
          fields={fields}
          getAddressKind={getAddressKind}
          getAddressMark={getAddressMark}
          onAddressClick={onAddressClick}
        />
      ) : (
        '{}'
      )}
    </MessageContent>
  );
}

function FieldList({
  fields,
  getAddressKind,
  getAddressMark,
  onAddressClick,
}: {
  fields: TypedDataFieldValue[];
  getAddressKind?: (address: string) => AddressKind;
  getAddressMark?: (address: string) => AddressMark | undefined;
  onAddressClick?: (address: string) => void;
}): ReactNode {
  return (
    <Fields>
      {fields.map(field => {
        const chainId =
          field.kind === 'value' &&
          field.name === 'chainId' &&
          /^uint\d+$/.test(field.type)
            ? BigInt(field.value).toString()
            : undefined;

        return (
          <Field key={field.name}>
            <FieldHeader>
              {formatSigningJSON(field.name).slice(1, -1)}
            </FieldHeader>
            <FieldValue
              $block={field.kind !== 'value' || field.type === 'address'}
            >
              {field.kind === 'value' ? (
                field.type === 'address' ? (
                  <ExpandableAddress
                    kind={getAddressKind?.(field.value as string)}
                    mark={getAddressMark?.(field.value as string)}
                    onClick={
                      onAddressClick
                        ? () => onAddressClick(field.value as string)
                        : undefined
                    }
                  >
                    {getAddress(field.value as string)}
                  </ExpandableAddress>
                ) : chainId !== undefined ? (
                  <ChainValue chainId={`eip155:${chainId}`} />
                ) : (
                  formatValue(field.type, field.value)
                )
              ) : field.children.length ? (
                <FieldList
                  fields={field.children}
                  getAddressKind={getAddressKind}
                  getAddressMark={getAddressMark}
                  onAddressClick={onAddressClick}
                />
              ) : field.kind === 'array' ? (
                '[]'
              ) : (
                '{}'
              )}
            </FieldValue>
          </Field>
        );
      })}
    </Fields>
  );
}

function formatValue(type: string, value: string | boolean): ReactNode {
  if (type === 'string') return formatSigningJSON(value as string).slice(1, -1);
  if (/^u?int\d+$/.test(type)) return BigInt(value).toString();
  return String(value);
}
