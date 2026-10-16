import type {EvmTypedData} from './evm-typed-data.js';

export type TypedDataFieldValue = {
  name: string;
  type: string;
} & (
  | {kind: 'value'; value: string | boolean}
  | {kind: 'struct' | 'array'; children: TypedDataFieldValue[]}
);

export function getTypedDataFields(
  types: EvmTypedData['types'],
  type: string,
  value: Record<string, unknown>,
): TypedDataFieldValue[] {
  return types[type]!.map(field =>
    getTypedDataField(types, field.name, field.type, value[field.name]),
  );
}

export function getTypedDataAddresses(data: EvmTypedData): string[] {
  const addresses = new Set<string>();

  const visit = (fields: TypedDataFieldValue[]): void => {
    for (const field of fields) {
      if (field.kind !== 'value') {
        visit(field.children);
      } else if (field.type === 'address') {
        addresses.add((field.value as string).toLowerCase());
      }
    }
  };

  visit(getTypedDataFields(data.types, 'EIP712Domain', data.domain));
  visit(getTypedDataFields(data.types, data.primaryType, data.message));
  return Array.from(addresses);
}

function getTypedDataField(
  types: EvmTypedData['types'],
  name: string,
  type: string,
  value: unknown,
): TypedDataFieldValue {
  const array = /^(.*)\[\d*\]$/s.exec(type);

  if (array) {
    return {
      name,
      type,
      kind: 'array',
      children: (value as unknown[]).map((item, index) =>
        getTypedDataField(types, `[${index}]`, array[1]!, item),
      ),
    };
  }

  if (Object.hasOwn(types, type)) {
    return {
      name,
      type,
      kind: 'struct',
      children: getTypedDataFields(
        types,
        type,
        value as Record<string, unknown>,
      ),
    };
  }

  return {name, type, kind: 'value', value: value as string | boolean};
}
