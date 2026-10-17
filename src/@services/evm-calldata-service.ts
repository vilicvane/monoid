import {Interface, type InterfaceAbi, ZeroAddress, getAddress} from 'ethers';

import {
  type EvmCalldata,
  type EvmCalldataResolver,
  type EvmContractVerification,
  decodeEvmCalldata,
} from '../@lib/evm-calldata.js';

import type {ChainService} from './chain-service.js';

const CONTRACT_URL = 'https://sourcify.dev/server/v2/contract';
const SIGNATURE_URL =
  'https://api.4byte.sourcify.dev/signature-database/v1/lookup';
const REQUEST_TIMEOUT = 8000;
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

type Contract = Awaited<ReturnType<EvmCalldataResolver['getContract']>>;

type ContractResponse = {
  chainId: string;
  address: string;
  abi: InterfaceAbi;
  runtimeMatch?: unknown;
  creationMatch?: unknown;
  verifiedAt?: unknown;
  proxyResolution?: {
    isProxy: boolean;
    implementations?: {address: string}[];
    proxyResolutionError?: unknown;
  };
};

type SignatureResponse = {
  ok: boolean;
  result: {
    function: Record<string, {name: string}[] | null>;
  };
};

export class EvmCalldataService {
  constructor(private chainService: Pick<ChainService, 'getRPC'>) {}

  async decode(
    chainId: string,
    target: string | undefined,
    data: string,
    signal?: AbortSignal,
  ): Promise<EvmCalldata> {
    signal?.throwIfAborted();
    if (!/^eip155:[1-9]\d*$/.test(chainId)) {
      throw new Error('This network does not support EVM transactions.');
    }

    const contracts = new Map<string, Promise<Contract>>();
    const signatures = new Map<string, Promise<string[]>>();
    const resolver: EvmCalldataResolver = {
      getContract: address => {
        address = getAddress(address);
        let contract = contracts.get(address);
        if (!contract) {
          contract = this.getContract(chainId, address, signal);
          contracts.set(address, contract);
        }
        return contract;
      },
      getSignatures: selector => {
        selector = selector.toLowerCase();
        let result = signatures.get(selector);
        if (!result) {
          result = this.getSignatures(selector, signal);
          signatures.set(selector, result);
        }
        return result;
      },
    };

    return abortable(decodeEvmCalldata(data, target, resolver), signal);
  }

  private async getContract(
    chainId: string,
    address: string,
    signal?: AbortSignal,
  ): Promise<Contract> {
    let iface: Interface | undefined;
    let verification: EvmContractVerification | undefined;
    let isProxy: boolean | undefined;
    let failure: unknown;

    try {
      const contract = await request(async requestSignal => {
        const response = await fetch(
          `${CONTRACT_URL}/${chainId.split(':')[1]}/${address}?fields=abi,proxyResolution`,
          {signal: requestSignal},
        );
        if (response.status === 404) return undefined;
        if (!response.ok) {
          throw new Error(
            `Could not load contract ABI: HTTP ${response.status}.`,
          );
        }

        const result = (await response.json()) as ContractResponse;
        if (
          result.chainId !== chainId.split(':')[1] ||
          getAddress(result.address) !== address ||
          !Array.isArray(result.abi)
        ) {
          throw new Error('Invalid contract ABI response.');
        }

        return result;
      }, signal);

      if (contract) {
        iface = contract.abi.length ? new Interface(contract.abi) : undefined;
        verification = parseVerification(contract);
        if (contract.proxyResolution?.isProxy === true) isProxy = true;
        const implementations =
          contract.proxyResolution?.implementations?.map(implementation =>
            getAddress(implementation.address),
          ) ?? [];

        if (
          implementations.length ||
          (!contract.proxyResolution?.proxyResolutionError &&
            contract.proxyResolution?.isProxy === false)
        ) {
          return {
            iface,
            implementations,
            verification,
            isProxy: !!implementations.length,
          };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }

    // Missing ABI or incomplete proxy metadata can still resolve through RPC.
    try {
      const implementation = await request(async requestSignal => {
        const provider = await this.chainService.getRPC(chainId);
        requestSignal.throwIfAborted();
        const storage = await provider.getStorage(address, IMPLEMENTATION_SLOT);
        return getAddress(`0x${storage.slice(-40)}`);
      }, signal);

      if (implementation !== ZeroAddress) {
        return {
          iface,
          implementations: [implementation],
          verification,
          isProxy: true,
          issue: failure ? 'unavailable' : undefined,
        };
      }
      if (isProxy !== true) isProxy = false;
    } catch (error) {
      signal?.throwIfAborted();
      if (!iface) throw error;
      failure ??= error;
    }

    return {
      iface,
      implementations: [],
      verification,
      isProxy,
      issue: failure ? 'unavailable' : undefined,
    };
  }

  private async getSignatures(
    selector: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return request(async requestSignal => {
      const response = await fetch(
        `${SIGNATURE_URL}?function=${selector}&filter=false`,
        {signal: requestSignal},
      );
      if (!response.ok) {
        throw new Error(
          `Could not load function signatures: HTTP ${response.status}.`,
        );
      }

      const result = (await response.json()) as SignatureResponse;
      const signatures = result.result?.function?.[selector];
      if (!result.ok || (signatures !== null && !Array.isArray(signatures))) {
        throw new Error('Invalid function signature response.');
      }

      return (signatures ?? []).map(signature => {
        if (typeof signature.name !== 'string') {
          throw new Error('Invalid function signature.');
        }
        return signature.name;
      });
    }, signal);
  }
}

function parseVerification({
  runtimeMatch,
  creationMatch,
  verifiedAt,
}: ContractResponse): EvmContractVerification | undefined {
  const isMatch = (
    value: unknown,
  ): value is EvmContractVerification['runtimeMatch'] =>
    value === null || value === 'match' || value === 'exact_match';

  if (!isMatch(runtimeMatch) || !isMatch(creationMatch)) return undefined;

  return {
    runtimeMatch,
    creationMatch,
    verifiedAt:
      typeof verifiedAt === 'string' && !Number.isNaN(Date.parse(verifiedAt))
        ? verifiedAt
        : undefined,
  };
}

async function request<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, {once: true});
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('ABI lookup timed out.', 'TimeoutError'));
  }, REQUEST_TIMEOUT);

  try {
    return await abortable(callback(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
