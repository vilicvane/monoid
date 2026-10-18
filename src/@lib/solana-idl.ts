import {type getNodeCodec, getNodeCodecVisitor} from '@codama/dynamic-codecs';
import {
  type InstructionNode,
  type RootNode,
  type TypeNode,
  camelCase,
} from '@codama/nodes';
import {
  type AnchorIdl,
  getAnchorInstructionDiscriminatorV00,
  rootNodeFromAnchorWithoutDefaultVisitor,
} from '@codama/nodes-from-anchor';
import {
  LinkableDictionary,
  NodeStack,
  getRecordLinkablesVisitor,
  interceptVisitor,
  visit,
} from '@codama/visitors-core';
import {base58, hex} from '@scure/base';

import type {SolanaInstructionReview} from './solana-transaction-review.js';
import type {TypedDataFieldValue} from './typed-data-fields.js';

const MAX_DATA_BYTES = 16_384;
const MAX_SCHEMA_NODES = 20_000;
const MAX_TYPE_DEPTH = 32;
const MAX_DECODE_NODES = 4096;

type FieldType =
  | {kind: 'value'; type: string}
  | {kind: 'array'; item: FieldType}
  | {kind: 'struct'; fields: NamedField[]}
  | {kind: 'option'; item: FieldType}
  | {
      kind: 'enum';
      variants: {name: string; fields: NamedField[]; tuple: boolean}[];
    };

type NamedField = {name: string; type: FieldType};
type Instruction = {
  source: Record<string, unknown>;
  discriminator: Uint8Array;
};

export type SolanaIdl = {
  source: Record<string, unknown>;
  programAddress: string;
  instructions: Instruction[];
};

export type SolanaIdlInstruction = {
  name: string;
  fields: TypedDataFieldValue[];
  accountNames: (string | undefined)[];
  programName?: string;
  version?: string;
};

export function parseSolanaIdl(
  value: unknown,
  programAddress: string,
): SolanaIdl | undefined {
  try {
    if (base58.decode(programAddress).length !== 32) return undefined;

    validateInput(value);

    if (!isObject(value) || !Array.isArray(value.instructions))
      return undefined;

    const metadata = isObject(value.metadata) ? value.metadata : {};
    const modern = metadata.spec === '0.1.0';

    if (
      (metadata.spec !== undefined && !modern) ||
      (metadata.origin !== undefined && metadata.origin !== 'anchor') ||
      (value.address !== undefined && value.address !== programAddress) ||
      (metadata.address !== undefined && metadata.address !== programAddress) ||
      (modern && value.address !== programAddress)
    ) {
      return undefined;
    }

    const instructions = value.instructions.map((source: unknown) => {
      if (!isObject(source) || typeof source.name !== 'string')
        throw new Error('Invalid instruction.');
      const bytes = modern
        ? source.discriminator
        : Array.from(
            hex.decode(getAnchorInstructionDiscriminatorV00(source.name).data),
          );
      if (
        !Array.isArray(bytes) ||
        !bytes.length ||
        bytes.length > 32 ||
        bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        throw new Error('Invalid discriminator.');
      if (!modern && source.discriminant !== undefined)
        throw new Error('Unsupported discriminator.');
      return {source, discriminator: Uint8Array.from(bytes)};
    });
    assertNames(
      instructions.map(({source}) => ({
        name: camelCase(source.name as string),
      })),
    );

    for (let i = 0; i < instructions.length; i++) {
      for (const other of instructions.slice(i + 1)) {
        const a = instructions[i].discriminator;
        const b = other.discriminator;

        if (
          a
            .subarray(0, Math.min(a.length, b.length))
            .every((v, j) => v === b[j])
        ) {
          return undefined;
        }
      }
    }

    return {source: value, programAddress, instructions};
  } catch {
    return undefined;
  }
}

export function decodeSolanaIdlInstruction(
  idl: SolanaIdl,
  instruction: Pick<
    SolanaInstructionReview,
    'programAddress' | 'accounts' | 'data'
  >,
): SolanaIdlInstruction | undefined {
  const {programAddress, accounts, data} = instruction;

  if (programAddress !== idl.programAddress || data.length > MAX_DATA_BYTES) {
    return undefined;
  }

  const matched = idl.instructions.find(({discriminator}) =>
    discriminator.every((byte, index) => data[index] === byte),
  );

  if (!matched) return undefined;

  try {
    // The default visitor flattens struct arguments for generated clients;
    // review keeps the original nesting and only loads this instruction's types.
    const root = rootNodeFromAnchorWithoutDefaultVisitor({
      ...idl.source,
      metadata: {
        ...(isObject(idl.source.metadata) ? idl.source.metadata : {}),
        address: programAddress,
      },
      instructions: [matched.source],
      types: getReferencedTypes(idl.source, matched.source.args),
      accounts: [],
      events: [],
      errors: [],
      constants: [],
    } as unknown as AnchorIdl);
    const node = root.program.instructions![0];
    const namedAccounts = node.accounts ?? [];
    const args = (node.arguments ?? []).slice(1);
    const definedTypes = root.program.definedTypes ?? [];
    assertNames(definedTypes);
    const definitions = new Map<string, TypeNode>(
      definedTypes.map(type => [type.name, type.type]),
    );
    assertNames(namedAccounts);
    assertNames(node.arguments ?? []);

    // Omitted optional accounts cannot be assigned names by position reliably.
    if (
      accounts.length < namedAccounts.length ||
      (node.optionalAccountStrategy === 'omitted' &&
        namedAccounts.some(account => account.isOptional))
    )
      return undefined;

    const budget = {nodes: 0};
    const fields = args.map(field => ({
      name: field.name,
      type: readType(field.type, definitions, 0, budget),
    }));
    const codec = getInstructionCodec(root, node);
    const [value, offset] = codec.read(data, 0);
    const encoded = codec.encode(value);

    // Also reject noncanonical values, missing vector prefixes and invalid
    // UTF-8 that a permissive decoder could otherwise normalize silently.
    if (
      offset !== data.length ||
      encoded.length !== data.length ||
      !encoded.every((byte, index) => byte === data[index]) ||
      !isObject(value)
    ) {
      return undefined;
    }

    return {
      name: node.name,
      fields: fields.map(field =>
        getField(field.name, field.type, value[field.name]),
      ),
      accountNames: accounts.map((_, index) => namedAccounts[index]?.name),
      programName: root.program.name,
      version: root.program.version,
    };
  } catch {
    return undefined;
  }
}

function getInstructionCodec(
  root: RootNode,
  instruction: InstructionNode,
): ReturnType<typeof getNodeCodec> {
  const linkables = new LinkableDictionary();
  visit(root, getRecordLinkablesVisitor(linkables));
  let reads = 0;
  const visitor = interceptVisitor(
    getNodeCodecVisitor(linkables, {
      stack: new NodeStack([root, root.program]),
      bytesEncoding: 'base16',
    }),
    (node, next) => {
      const codec = next(node);
      return {
        ...codec,
        read(bytes, offset) {
          // Kit otherwise accepts a missing vector prefix as an empty vector.
          // Count every nested read before allocation, including zero-byte structs.
          if (
            ++reads > MAX_DECODE_NODES ||
            (node.kind === 'arrayTypeNode' &&
              node.count.kind === 'prefixedCountNode' &&
              offset + 4 > bytes.length)
          )
            throw new Error('Invalid or excessive instruction data.');
          return codec.read(bytes, offset);
        },
      };
    },
  );
  return visit(instruction, visitor);
}

function readType(
  node: TypeNode,
  definitions: Map<string, TypeNode>,
  depth = 0,
  budget = {nodes: 0},
): FieldType {
  if (depth > MAX_TYPE_DEPTH || ++budget.nodes > 4000)
    throw new Error('IDL type is too deeply nested.');

  const child = (type: TypeNode): FieldType =>
    readType(type, definitions, depth + 1, budget);
  const fields = (items: {name: string; type: TypeNode}[]): NamedField[] => {
    assertNames(items);
    return items.map(item => ({name: item.name, type: child(item.type)}));
  };

  switch (node.kind) {
    case 'numberTypeNode': {
      if (!/^[ui](?:8|16|32|64|128)$|^f(?:32|64)$/.test(node.format)) break;
      return {kind: 'value', type: node.format};
    }
    case 'booleanTypeNode':
      return {kind: 'value', type: 'bool'};
    case 'publicKeyTypeNode':
      return {kind: 'value', type: 'pubkey'};
    case 'sizePrefixTypeNode': {
      if (node.prefix.kind !== 'numberTypeNode' || node.prefix.format !== 'u32')
        break;
      if (node.type.kind === 'bytesTypeNode') {
        return {kind: 'value', type: 'bytes'};
      }
      if (
        node.type.kind === 'stringTypeNode' &&
        node.type.encoding === 'utf8'
      ) {
        return {kind: 'value', type: 'string'};
      }
      break;
    }
    case 'definedTypeLinkNode': {
      const definition = definitions.get(node.name);
      if (definition) return child(definition);
      break;
    }
    case 'structTypeNode': {
      return {kind: 'struct', fields: fields(node.fields ?? [])};
    }
    case 'tupleTypeNode': {
      const children = (node.items ?? []).map((type, index) => ({
        name: `[${index}]`,
        type: child(type),
      }));
      return {kind: 'struct', fields: children};
    }
    case 'arrayTypeNode': {
      const item = child(node.item);
      const count = node.count;
      if (
        count.kind === 'fixedCountNode' &&
        Number.isSafeInteger(count.value) &&
        count.value >= 0 &&
        count.value <= 1024
      ) {
        return {kind: 'array', item};
      }
      if (
        count.kind === 'prefixedCountNode' &&
        count.prefix.kind === 'numberTypeNode' &&
        count.prefix.format === 'u32'
      ) {
        return {kind: 'array', item};
      }
      break;
    }
    case 'optionTypeNode': {
      if (
        node.prefix.kind !== 'numberTypeNode' ||
        !['u8', 'u32'].includes(node.prefix.format)
      )
        break;
      return {kind: 'option', item: child(node.item)};
    }
    case 'enumTypeNode': {
      if (
        node.size.kind !== 'numberTypeNode' ||
        node.size.format !== 'u8' ||
        !node.variants?.length ||
        node.variants.length > 256
      )
        break;
      assertNames(node.variants);
      const variants = node.variants.map((variant, index) => {
        if (
          variant.discriminator !== undefined &&
          variant.discriminator !== index
        )
          throw new Error('Unsupported enum discriminator.');
        const payload =
          variant.kind === 'enumEmptyVariantTypeNode'
            ? {kind: 'struct' as const, fields: []}
            : child(
                variant.kind === 'enumStructVariantTypeNode'
                  ? variant.struct
                  : variant.tuple,
              );
        if (payload.kind !== 'struct')
          throw new Error('Unsupported enum variant.');
        return {
          name: variant.name,
          fields: payload.fields,
          tuple: variant.kind === 'enumTupleVariantTypeNode',
        };
      });
      return {kind: 'enum', variants};
    }
  }

  throw new Error('Unsupported IDL type.');
}

function getField(
  name: string,
  type: FieldType,
  value: unknown,
): TypedDataFieldValue {
  let children: TypedDataFieldValue[];
  const object = value as Record<string, unknown>;
  switch (type.kind) {
    case 'value': {
      if (type.type === 'bytes') value = `0x${(value as [string, string])[1]}`;
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error('Invalid number.');
      return {
        name,
        type: type.type,
        kind: 'value',
        value:
          typeof value === 'boolean'
            ? value
            : Object.is(value, -0)
              ? '-0'
              : String(value),
      };
    }
    case 'array': {
      return {
        name,
        type: 'array',
        kind: 'array',
        children: (value as unknown[]).map((item, index) =>
          getField(`[${index}]`, type.item, item),
        ),
      };
    }
    case 'struct': {
      children = type.fields.map((field, index) =>
        getField(
          field.name,
          field.type,
          Array.isArray(value) ? value[index] : object[field.name],
        ),
      );
      break;
    }
    case 'option': {
      if (object.__option === 'None')
        return {name, type: 'option', kind: 'value', value: 'None'};
      children = [getField('Some', type.item, object.value)];
      break;
    }
    case 'enum': {
      const variant = type.variants[object.__discriminator as number];
      if (!variant.fields.length)
        return {name, type: 'enum', kind: 'value', value: variant.name};
      const payload = variant.tuple ? object.fields : value;
      children = [
        getField(
          variant.name,
          {kind: 'struct', fields: variant.fields},
          payload,
        ),
      ];
      break;
    }
  }
  return {name, type: type.kind, kind: 'struct', children};
}

function getReferencedTypes(
  source: Record<string, unknown>,
  args: unknown,
): unknown[] {
  const definitions = new Map<string, Record<string, unknown>>();
  for (const type of Array.isArray(source.types) ? source.types : []) {
    if (
      !isObject(type) ||
      typeof type.name !== 'string' ||
      definitions.has(type.name)
    )
      throw new Error('Invalid IDL type definition.');
    definitions.set(type.name, type);
  }
  const selected = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, active = new Set<string>()): void => {
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, active));
    } else if (isObject(value)) {
      if (value.serialization !== undefined && value.serialization !== 'borsh')
        throw new Error('Unsupported serialization.');
      if (value.defined !== undefined) {
        const name =
          typeof value.defined === 'string'
            ? value.defined
            : isObject(value.defined)
              ? value.defined.name
              : undefined;
        const definition =
          typeof name === 'string' ? definitions.get(name) : undefined;
        if (
          !definition ||
          typeof name !== 'string' ||
          active.has(name) ||
          active.size >= MAX_TYPE_DEPTH
        )
          throw new Error('Unsupported type reference.');
        if (!selected.has(name)) {
          visit(definition, new Set([...active, name]));
          selected.set(name, definition);
        }
      }
      Object.values(value).forEach(item => visit(item, active));
    }
  };
  visit(args);
  return [...selected.values()];
}

function validateInput(value: unknown): void {
  let count = 0;
  let textSize = 0;

  const visit = (item: unknown, depth: number): void => {
    if (++count > MAX_SCHEMA_NODES || depth > 32)
      throw new Error('IDL is too large.');
    if (typeof item === 'string') {
      textSize += item.length;
      if (textSize > 1_000_000) throw new Error('IDL is too large.');
    } else if (Array.isArray(item)) {
      item.forEach(value => visit(value, depth + 1));
    } else if (isObject(item)) {
      for (const [key, value] of Object.entries(item)) {
        if (key === '__proto__') throw new Error('Invalid IDL property.');
        if (
          key === 'name' &&
          (typeof value !== 'string' ||
            !/^[a-z_][a-z\d_]{0,127}$/i.test(value) ||
            [
              '__proto__',
              'constructor',
              'prototype',
              '__kind',
              '__discriminator',
              '__option',
            ].includes(value))
        )
          throw new Error('Invalid IDL name.');
        visit(value, depth + 1);
      }
    } else if (item !== null && !['number', 'boolean'].includes(typeof item)) {
      throw new Error('Invalid IDL value.');
    }
  };

  visit(value, 0);
}

function assertNames(items: {name: string}[]): void {
  if (
    new Set(items.map(item => item.name)).size !== items.length ||
    items.some(({name}) =>
      [
        '__proto__',
        'constructor',
        'prototype',
        '__kind',
        '__discriminator',
        '__option',
      ].includes(name),
    )
  ) {
    throw new Error('Duplicate IDL name.');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
