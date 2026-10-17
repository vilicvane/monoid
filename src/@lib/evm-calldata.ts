import {FunctionFragment, Interface, type ParamType, getAddress} from 'ethers';

import type {TypedDataFieldValue} from './typed-data-fields.js';

export type EvmCalldata = {
  data: string;
  target?: string;
  // Final implementation identity, independent of which address supplied ABI.
  contractAddress?: string;
  candidates: EvmCalldataCandidate[];
  issue?: 'unavailable' | 'limit';
};

export type EvmCalldataCandidate = {
  signature: string;
  source: 'abi' | 'signature';
  abiAddress?: string;
  verification?: EvmContractVerification;
  fields: TypedDataFieldValue[];
  calls: Record<string, EvmCalldata>;
};

export type EvmContractVerification = {
  runtimeMatch: 'match' | 'exact_match' | null;
  creationMatch: 'match' | 'exact_match' | null;
  verifiedAt?: string;
};

export type EvmCalldataResolver = {
  getContract: (address: string) => Promise<{
    iface?: Interface;
    implementations: string[];
    isProxy?: boolean;
    issue?: 'unavailable';
    verification?: EvmContractVerification;
  }>;
  getSignatures: (selector: string) => Promise<string[]>;
};

// Calldata and remote ABIs are untrusted. Bound both lookup work and the tree
// rendered on the confirmation screen; omitted data always remains accessible.
const MAX_DEPTH = 6;
const MAX_CALLS = 64;
const MAX_FIELDS = 2048;
const MAX_CANDIDATES = 4;
const MAX_DATA_BYTES = 128 * 1024;
const MAX_CONTRACTS = 8;

export async function decodeEvmCalldata(
  data: string,
  target: string | undefined,
  resolver: EvmCalldataResolver,
): Promise<EvmCalldata> {
  let remainingCalls = MAX_CALLS;
  let remainingFields = MAX_FIELDS;

  const decode = async (
    data: string,
    target: string | undefined,
    depth: number,
  ): Promise<EvmCalldata> => {
    const result: EvmCalldata = {data, target, candidates: []};
    if (!/^0x[\da-f]{8}(?:[\da-f]{64})*$/i.test(data)) return result;
    if (
      depth > MAX_DEPTH ||
      remainingCalls-- <= 0 ||
      data.length > MAX_DATA_BYTES * 2 + 2
    ) {
      return {...result, issue: 'limit'};
    }

    const addCandidate = (
      iface: Interface,
      fragment: FunctionFragment,
      source: EvmCalldataCandidate['source'],
      abiAddress?: string,
      verification?: EvmContractVerification,
    ): void => {
      const signature = fragment.format('sighash');
      if (result.candidates.some(item => item.signature === signature)) return;
      try {
        const args = iface.decodeFunctionData(fragment, data);
        // ethers tolerates some extra bytes and noncanonical encodings. Do not
        // silently omit anything from the payload being signed.
        if (
          iface.encodeFunctionData(fragment, args).toLowerCase() !==
          data.toLowerCase()
        )
          return;
        if (result.candidates.length >= MAX_CANDIDATES) {
          result.issue = 'limit';
          return;
        }
        const field = (
          param: ParamType,
          value: unknown,
          name: string,
        ): TypedDataFieldValue => {
          if (remainingFields-- <= 0) throw new RangeError('Field limit');
          if (param.isArray()) {
            return {
              name,
              type: param.type,
              kind: 'array',
              children: (value as unknown[]).map((item, index) =>
                field(param.arrayChildren, item, `[${index}]`),
              ),
            };
          }
          if (param.isTuple()) {
            return {
              name,
              type: param.type,
              kind: 'struct',
              children: param.components.map((item, index) =>
                field(
                  item,
                  (value as unknown[])[index],
                  item.name || `[${index}]`,
                ),
              ),
            };
          }
          return {
            name,
            type: param.type,
            kind: 'value',
            value: typeof value === 'boolean' ? value : String(value),
          };
        };
        result.candidates.push({
          signature,
          source,
          abiAddress,
          verification,
          fields: fragment.inputs.map((param, index) =>
            field(param, args[index], param.name || `[${index}]`),
          ),
          calls: {},
        });
      } catch (error) {
        if (error instanceof RangeError && remainingFields < 0)
          result.issue = 'limit';
        // A selector collision, malformed ABI, or invalid argument is not a
        // successful interpretation. Other candidates may still match.
      }
    };

    if (target) {
      const contracts = new Map<
        string,
        ReturnType<EvmCalldataResolver['getContract']>
      >();
      const getContract = (
        address: string,
      ): ReturnType<EvmCalldataResolver['getContract']> => {
        const key = address.toLowerCase();
        let contract = contracts.get(key);
        if (!contract) {
          contract = resolver.getContract(address);
          contracts.set(key, contract);
        }
        return contract;
      };
      const visited = new Set<string>();
      const visitContract = async (address: string): Promise<void> => {
        const key = address.toLowerCase();
        if (visited.has(key)) return;
        if (visited.size >= MAX_CONTRACTS) {
          result.issue = 'limit';
          return;
        }
        visited.add(key);
        try {
          const {iface, implementations, verification, issue} =
            await getContract(address);
          result.issue ??= issue;
          if (iface) {
            for (const fragment of iface.fragments) {
              if (fragment.type === 'function') {
                const fn = fragment as FunctionFragment;
                if (fn.selector === data.slice(0, 10).toLowerCase())
                  addCandidate(iface, fn, 'abi', address, verification);
              }
            }
          }
          if (!result.candidates.length) {
            for (const implementation of implementations)
              await visitContract(implementation);
          }
        } catch (error) {
          if (isAbort(error)) throw error;
          result.issue ??= 'unavailable';
        }
      };
      await visitContract(target);

      const resolveContract = async (
        address: string,
        path = new Set<string>(),
      ): Promise<string | undefined> => {
        const key = address.toLowerCase();
        if (path.has(key)) return undefined;
        if (path.size >= MAX_CONTRACTS) {
          result.issue = 'limit';
          return undefined;
        }
        path.add(key);

        try {
          const {implementations, isProxy, issue} = await getContract(address);
          result.issue ??= issue;
          if (implementations.length === 1) {
            return await resolveContract(implementations[0], path);
          }
          return !implementations.length && isProxy === false
            ? getAddress(address)
            : undefined;
        } catch (error) {
          if (isAbort(error)) throw error;
          result.issue ??= 'unavailable';
          return undefined;
        }
      };
      result.contractAddress = await resolveContract(target);
    }

    if (!result.candidates.length) {
      try {
        const signatures = await resolver.getSignatures(
          data.slice(0, 10).toLowerCase(),
        );
        for (const signature of signatures) {
          try {
            const fragment = FunctionFragment.from(`function ${signature}`);
            if (fragment.selector === data.slice(0, 10).toLowerCase())
              addCandidate(new Interface([fragment]), fragment, 'signature');
          } catch {
            // Ignore malformed entries from the public signature directory.
          }
        }
      } catch (error) {
        if (isAbort(error)) throw error;
        result.issue ??= 'unavailable';
      }
    }

    for (const candidate of result.candidates) {
      for (const nested of getNestedCalls(candidate, target)) {
        candidate.calls[nested.path] = await decode(
          nested.data,
          nested.target,
          depth + 1,
        );
      }
    }
    return result;
  };

  return decode(data, target, 0);
}

// These layouts identify bytes that carry another call. An arbitrary bytes
// parameter (a signature, proof, or protocol-specific payload) stays raw.
function getNestedCalls(
  candidate: EvmCalldataCandidate,
  target?: string,
): {path: string; data: string; target?: string}[] {
  const {signature, fields} = candidate;
  const calls: {path: string; data: string; target?: string}[] = [];
  const add = (
    field: TypedDataFieldValue,
    path: string,
    target?: string,
  ): void => {
    if (field.kind === 'value' && field.type === 'bytes') {
      calls.push({path, data: field.value as string, target});
    }
  };
  const address = (field: TypedDataFieldValue): string | undefined =>
    field.kind === 'value' && field.type === 'address'
      ? getAddress(field.value as string)
      : undefined;

  if (
    [
      'multicall(bytes[])',
      'multicall(uint256,bytes[])',
      'multicall(bytes32,bytes[])',
    ].includes(signature)
  ) {
    const index = fields.length - 1;
    const batch = fields[index];
    if (batch.kind === 'array')
      batch.children.forEach((field, item) =>
        add(field, `${index}.${item}`, target),
      );
  } else if (
    [
      'aggregate((address,bytes)[])',
      'tryAggregate(bool,(address,bytes)[])',
      'blockAndAggregate((address,bytes)[])',
      'tryBlockAndAggregate(bool,(address,bytes)[])',
      'aggregate3((address,bool,bytes)[])',
      'aggregate3Value((address,bool,uint256,bytes)[])',
    ].includes(signature)
  ) {
    const index = fields.length - 1;
    const batch = fields[index];
    if (batch.kind === 'array') {
      batch.children.forEach((tuple, item) => {
        if (tuple.kind !== 'struct') return;
        const dataIndex = tuple.children.length - 1;
        add(
          tuple.children[dataIndex],
          `${index}.${item}.${dataIndex}`,
          address(tuple.children[0]),
        );
      });
    }
  } else if (signature === 'execute(address,uint256,bytes)') {
    add(fields[2], '2', address(fields[0]));
  } else if (
    signature ===
    'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'
  ) {
    add(fields[2], '2', address(fields[0]));
  }
  return calls;
}

export function getEvmCalldataAddresses(
  data: EvmCalldata,
  unambiguousOnly = false,
): string[] {
  const addresses = new Set<string>();
  const visit = (data: EvmCalldata): void => {
    if (
      unambiguousOnly &&
      (data.candidates.length !== 1 || data.issue === 'limit')
    )
      return;
    const fields = (values: TypedDataFieldValue[]): void => {
      for (const field of values) {
        if (field.kind !== 'value') fields(field.children);
        else if (field.type === 'address')
          addresses.add((field.value as string).toLowerCase());
      }
    };
    for (const candidate of data.candidates) {
      fields(candidate.fields);
      Object.values(candidate.calls).forEach(visit);
    }
  };
  visit(data);
  return [...addresses];
}

export function getEvmCalldataCalls(
  data: EvmCalldata,
): {contractAddress: string; signature: string}[] {
  const calls = new Map<string, {contractAddress: string; signature: string}>();
  const visit = (data: EvmCalldata): void => {
    if (data.candidates.length !== 1 || data.issue === 'limit') return;
    const candidate = data.candidates[0];
    if (data.contractAddress) {
      const contractAddress = getAddress(data.contractAddress);
      calls.set(`${contractAddress}:${candidate.signature}`, {
        contractAddress,
        signature: candidate.signature,
      });
    }
    Object.values(candidate.calls).forEach(visit);
  };

  visit(data);
  return [...calls.values()];
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
