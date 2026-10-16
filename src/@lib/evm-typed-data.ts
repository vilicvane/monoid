import {TypedDataEncoder, type TypedDataField, concat, keccak256} from 'ethers';

export type EvmTypedData = {
  domain: Record<string, string>;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

export function parseEvmTypedData(value: unknown): {
  data: EvmTypedData;
  digest: string;
} {
  const input: unknown = typeof value === 'string' ? JSON.parse(value) : value;

  if (
    !isObject(input) ||
    !isObject(input.domain) ||
    !isObject(input.types) ||
    !isObject(input.message) ||
    typeof input.primaryType !== 'string'
  ) {
    throw new Error('Invalid typed data.');
  }

  const {EIP712Domain: domainFields, ...types} = input.types as Record<
    string,
    TypedDataField[]
  >;

  // Ethers builds plain objects while visiting fields; this name would hide a
  // signed struct on the prototype instead of keeping it in the visible data.
  if (
    Object.entries(types).some(
      ([name, fields]) =>
        name === '__proto__' ||
        fields.some(field => field.name === '__proto__'),
    )
  ) {
    throw new Error('Unsupported typed data field name.');
  }

  if (
    Object.values(types).some(fields =>
      fields.some(field => /^(?:uint|int)(?:\[|$)/.test(field.type)),
    )
  ) {
    throw new Error('Integer fields must specify their bit width.');
  }

  const encoder = TypedDataEncoder.from(types);

  if (input.primaryType !== encoder.primaryType) {
    throw new Error('Invalid primary type.');
  }

  // Ethers coerces bool values; reject ambiguous inputs before normalizing.
  encoder.visit(input.message, (type, value: unknown) => {
    if (type === 'bool' && typeof value !== 'boolean') {
      throw new Error('Invalid boolean field.');
    }
    return value;
  });

  const data = TypedDataEncoder.getPayload(
    input.domain,
    types,
    input.message,
  ) as EvmTypedData;
  const expectedDomainFields = data.types.EIP712Domain!;

  if (
    !Array.isArray(domainFields) ||
    domainFields.length !== expectedDomainFields.length ||
    new Set(domainFields.map(field => field.name)).size !==
      domainFields.length ||
    domainFields.some(
      field =>
        !expectedDomainFields.some(
          expected =>
            expected.name === field.name && expected.type === field.type,
        ),
    ) ||
    Object.keys(input.domain).length !== expectedDomainFields.length
  ) {
    throw new Error('Invalid signing domain.');
  }

  // Keep the declared domain field order: it is part of the signed type hash.
  data.types.EIP712Domain = domainFields;
  const domainHash = TypedDataEncoder.hashStruct(
    'EIP712Domain',
    {EIP712Domain: domainFields},
    data.domain,
  );
  const digest = keccak256(
    concat(['0x1901', domainHash, encoder.hash(data.message)]),
  );

  return {data, digest};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
