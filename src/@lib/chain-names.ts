// Common offline names from https://chainlist.org/rpcs.json, checked 2026-10-16.
// These labels describe networks; they do not verify a chain's identity.
export const BUILTIN_CHAIN_NAMES: Readonly<Record<string, string>> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'Solana Devnet',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'Solana Testnet',
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

// EIP-3091 explorers from ChainList; HyperEVMScan uses the same transaction path.
export const BUILTIN_CHAIN_EXPLORERS: Readonly<Record<string, string>> = {
  'eip155:1': 'https://etherscan.io',
  'eip155:10': 'https://optimistic.etherscan.io',
  'eip155:56': 'https://bscscan.com',
  'eip155:100': 'https://gnosisscan.io',
  'eip155:137': 'https://polygonscan.com',
  'eip155:250': 'https://ftmscan.com',
  'eip155:324': 'https://explorer.zksync.io',
  'eip155:999': 'https://hyperevmscan.io',
  'eip155:8453': 'https://basescan.org',
  'eip155:42161': 'https://arbiscan.io',
  'eip155:43114': 'https://snowscan.xyz',
  'eip155:59144': 'https://lineascan.build',
  'eip155:84532': 'https://sepolia.basescan.org',
  'eip155:421614': 'https://sepolia.arbiscan.io',
  'eip155:534352': 'https://scrollscan.com',
  'eip155:11155111': 'https://sepolia.etherscan.io',
  'eip155:11155420': 'https://sepolia-optimism.etherscan.io',
};

export type NativeCurrency = {
  symbol: string;
  decimals: number;
};

export const BUILTIN_CHAIN_CURRENCIES: Readonly<
  Record<string, NativeCurrency>
> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {symbol: 'SOL', decimals: 9},
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': {symbol: 'SOL', decimals: 9},
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': {symbol: 'SOL', decimals: 9},
  'eip155:1': {symbol: 'ETH', decimals: 18},
  'eip155:10': {symbol: 'ETH', decimals: 18},
  'eip155:56': {symbol: 'BNB', decimals: 18},
  'eip155:100': {symbol: 'XDAI', decimals: 18},
  'eip155:137': {symbol: 'POL', decimals: 18},
  'eip155:250': {symbol: 'FTM', decimals: 18},
  'eip155:324': {symbol: 'ETH', decimals: 18},
  'eip155:999': {symbol: 'HYPE', decimals: 18},
  'eip155:8453': {symbol: 'ETH', decimals: 18},
  'eip155:42161': {symbol: 'ETH', decimals: 18},
  'eip155:43114': {symbol: 'AVAX', decimals: 18},
  'eip155:59144': {symbol: 'ETH', decimals: 18},
  'eip155:84532': {symbol: 'ETH', decimals: 18},
  'eip155:421614': {symbol: 'ETH', decimals: 18},
  'eip155:534352': {symbol: 'ETH', decimals: 18},
  'eip155:11155111': {symbol: 'ETH', decimals: 18},
  'eip155:11155420': {symbol: 'ETH', decimals: 18},
};

export type ChainDirectory = {
  names: Record<string, string>;
  icons: Record<string, string>;
  currencies: Record<string, NativeCurrency>;
  explorers: Record<string, string>;
};

export function parseChainDirectory(value: unknown): ChainDirectory {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('Invalid chain directory.');
  }

  const names: Record<string, string> = {};
  const icons: Record<string, string> = {};
  const currencies: Record<string, NativeCurrency> = {};
  const explorers: Record<string, string> = {};

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

    if ('explorers' in chain && Array.isArray(chain.explorers)) {
      for (const explorer of chain.explorers) {
        const url = getExplorerURL(explorer);
        if (url) {
          explorers[id] = url;
          break;
        }
      }
    }

    if (
      'chainSlug' in chain &&
      typeof chain.chainSlug === 'string' &&
      chain.chainSlug.trim()
    ) {
      icons[id] = getChainIconURL(chain.chainSlug.trim());
    }

    if ('nativeCurrency' in chain) {
      const currency = chain.nativeCurrency;
      if (
        typeof currency === 'object' &&
        currency !== null &&
        'symbol' in currency &&
        typeof currency.symbol === 'string' &&
        currency.symbol.trim() &&
        'decimals' in currency &&
        typeof currency.decimals === 'number' &&
        Number.isInteger(currency.decimals) &&
        currency.decimals >= 0 &&
        // ethers formatUnits supports at most 80 decimal places.
        currency.decimals <= 80
      ) {
        currencies[id] = {
          symbol: currency.symbol.trim(),
          decimals: currency.decimals,
        };
      }
    }
  }

  return {names, icons, currencies, explorers};
}

function getExplorerURL(explorer: unknown): string | undefined {
  if (
    typeof explorer !== 'object' ||
    explorer === null ||
    !('standard' in explorer) ||
    explorer.standard !== 'EIP3091' ||
    !('url' in explorer) ||
    typeof explorer.url !== 'string'
  ) {
    return undefined;
  }

  try {
    const url = new URL(explorer.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.href.includes('?') ||
      url.href.includes('#')
    ) {
      return undefined;
    }

    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function getChainIconURL(slug: string): string {
  return `https://icons.llamao.fi/icons/chains/rsz_${encodeURIComponent(slug)}.jpg`;
}
