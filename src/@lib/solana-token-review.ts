import {
  type SolanaTokenAccountData,
  loadSolanaTokenAccounts,
} from './solana-token-account.js';
import {
  isAssociatedTokenAddress,
  isSolanaTokenInstruction,
} from './solana-token-instruction.js';
import type {
  SolanaRPCRequest,
  SolanaTransactionReview,
} from './solana-transaction-review.js';

export type SolanaTokenReview = {
  mint?: string;
  decimals?: number;
  warning?: string;
  source?: SolanaTokenAccountReview;
  destination?: SolanaTokenAccountReview;
  accountExists?: boolean;
};

type SolanaTokenAccountReview = {owner: string; associated: boolean};

export async function loadSolanaTokenReviews(
  reviews: readonly SolanaTransactionReview[],
  request: SolanaRPCRequest,
  signal?: AbortSignal,
): Promise<SolanaTransactionReview[]> {
  signal?.throwIfAborted();
  const addresses = new Set<string>();
  const changedAccounts = new Set<string>();

  for (const review of reviews) {
    for (const instruction of review.instructions) {
      const {decoded} = instruction;

      if (isSolanaTokenInstruction(decoded)) {
        if ('source' in decoded) addresses.add(decoded.source);
        if ('destination' in decoded) addresses.add(decoded.destination);
        if ('mint' in decoded && decoded.mint) addresses.add(decoded.mint);
        if (decoded.kind === 'token-account-create') {
          addresses.add(decoded.account);
        }
      } else if (decoded.kind === 'unknown') {
        // RPC describes current state. Unknown CPI/authority changes can make it
        // stale, and a signAllTransactions request promises no execution order.
        for (const account of instruction.accounts) {
          if (account.isWritable) changedAccounts.add(account.address);
        }
      }
    }
  }

  if (!addresses.size) return [...reviews];
  let accounts: ReadonlyMap<string, SolanaTokenAccountData> = new Map();
  let unavailable = false;

  try {
    accounts = await loadSolanaTokenAccounts([...addresses], request, signal);
    const mints = Array.from(
      new Set(
        Array.from(accounts.values()).flatMap(account =>
          account.kind === 'account' && !addresses.has(account.mint)
            ? [account.mint]
            : [],
        ),
      ),
    );
    const mintAccounts = await loadSolanaTokenAccounts(mints, request, signal);
    accounts = new Map([...accounts, ...mintAccounts]);
  } catch {
    signal?.throwIfAborted();
    // Supplemental account data must not prevent review of the signed fields.
    // Unchecked amounts remain in base units when their precision is unknown.
    unavailable = true;
  }

  signal?.throwIfAborted();
  return reviews.map(review => {
    const current = new Map(accounts);
    for (const address of changedAccounts) current.delete(address);

    return {
      ...review,
      instructions: review.instructions.map(instruction => {
        const {decoded} = instruction;
        if (!isSolanaTokenInstruction(decoded)) return instruction;

        const source =
          'source' in decoded ? current.get(decoded.source) : undefined;
        const mint =
          ('mint' in decoded ? decoded.mint : undefined) ??
          (source?.kind === 'account' ? source.mint : undefined);
        const mintAccount = mint ? current.get(mint) : undefined;
        const decimals =
          ('decimals' in decoded ? decoded.decimals : undefined) ??
          (mintAccount?.kind === 'mint' ? mintAccount.decimals : undefined);
        let warning = unavailable ? 'Token details unavailable.' : undefined;

        if ('source' in decoded && source?.kind !== 'account') {
          warning = 'Token account details unavailable.';
        }
        if (
          source?.kind === 'account' &&
          mint !== undefined &&
          source.mint !== mint
        ) {
          warning = 'Token mint does not match the source account.';
        }
        if (decoded.kind === 'token-transfer') {
          const destination = current.get(decoded.destination);
          if (destination?.kind !== 'account') {
            warning ??= 'Destination token account details unavailable.';
          } else if (mint && destination.mint !== mint) {
            warning = 'Source and destination use different tokens.';
          }
        }
        if (mintAccount?.kind !== 'mint') {
          warning ??= 'Token mint details unavailable.';
        } else if (decimals !== mintAccount.decimals) {
          warning = 'Token decimals do not match the mint.';
        }

        const token: SolanaTokenReview = {mint, decimals, warning};

        if ('source' in decoded) {
          token.source = reviewTokenAccount(decoded.source, source, mint);
        }
        if (decoded.kind === 'token-transfer') {
          token.destination = reviewTokenAccount(
            decoded.destination,
            current.get(decoded.destination),
            mint,
          );
        }
        if (decoded.kind === 'token-account-create') {
          // The decoder verifies the associated account's PDA and programs.
          // This describes only later instructions in this same transaction.
          if (!changedAccounts.has(decoded.account)) {
            const account = accounts.get(decoded.account);

            if (account?.kind === 'account') {
              if (account.mint !== decoded.mint) {
                token.warning = 'Token mint does not match the account.';
              } else if (account.owner !== decoded.owner) {
                token.warning = 'Token owner does not match the account.';
              } else {
                token.accountExists = true;
              }
            } else {
              current.set(decoded.account, {
                kind: 'account',
                mint: decoded.mint,
                owner: decoded.owner,
              });
            }
          }
        }

        return {...instruction, token};
      }),
    };
  });
}

function reviewTokenAccount(
  address: string,
  account: SolanaTokenAccountData | undefined,
  mint: string | undefined,
): SolanaTokenAccountReview | undefined {
  if (account?.kind !== 'account' || !mint || account.mint !== mint) {
    return undefined;
  }

  return {
    owner: account.owner,
    associated: isAssociatedTokenAddress(address, account.owner, mint),
  };
}
