// Common offline names from https://chainlist.org/rpcs.json, checked 2026-10-16.
// These labels describe networks; they do not verify a chain's identity.
export const BUILTIN_CHAIN_NAMES: Readonly<Record<string, string>> = {
  'eip155:1': 'Ethereum Mainnet',
  'eip155:10': 'OP Mainnet',
  'eip155:56': 'BNB Smart Chain Mainnet',
  'eip155:100': 'Gnosis',
  'eip155:137': 'Polygon Mainnet',
  'eip155:250': 'Fantom Opera',
  'eip155:324': 'zkSync Mainnet',
  'eip155:999': 'HyperEVM',
  'eip155:8453': 'Base',
  'eip155:42161': 'Arbitrum One',
  'eip155:43114': 'Avalanche C-Chain',
  'eip155:59144': 'Linea',
  'eip155:84532': 'Base Sepolia Testnet',
  'eip155:421614': 'Arbitrum Sepolia',
  'eip155:534352': 'Scroll',
  'eip155:11155111': 'Ethereum Sepolia',
  'eip155:11155420': 'OP Sepolia Testnet',
};

// ChainList uses these slugs with the DefiLlama icon host.
export const BUILTIN_CHAIN_ICONS: Readonly<Record<string, string>> = {
  'eip155:1': getChainIconURL('ethereum'),
  'eip155:10': getChainIconURL('optimism'),
  'eip155:137': getChainIconURL('polygon'),
  'eip155:999': getChainIconURL('hyperliquid'),
  'eip155:8453': getChainIconURL('base'),
};

export type ChainDirectory = {
  names: Record<string, string>;
  icons: Record<string, string>;
};

export function parseChainDirectory(value: unknown): ChainDirectory {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('Invalid chain directory.');
  }

  const names: Record<string, string> = {};
  const icons: Record<string, string> = {};

  for (const chain of value) {
    if (
      typeof chain !== 'object' ||
      chain === null ||
      !('chainId' in chain) ||
      typeof chain.chainId !== 'number' ||
      !Number.isSafeInteger(chain.chainId) ||
      chain.chainId <= 0 ||
      !('name' in chain) ||
      typeof chain.name !== 'string' ||
      !chain.name.trim()
    ) {
      throw new Error('Invalid chain directory entry.');
    }

    const id = `eip155:${chain.chainId}`;

    if (names[id] !== undefined) {
      throw new Error('Duplicate chain directory entry.');
    }

    names[id] = chain.name.trim();

    if (
      'chainSlug' in chain &&
      typeof chain.chainSlug === 'string' &&
      chain.chainSlug.trim()
    ) {
      icons[id] = getChainIconURL(chain.chainSlug.trim());
    }
  }

  return {names, icons};
}

function getChainIconURL(slug: string): string {
  return `https://icons.llamao.fi/icons/chains/rsz_${encodeURIComponent(slug)}.jpg`;
}
