import {
  type GasSample,
  SAMPLE_INTERVAL_SECONDS,
  WEEK_SECONDS,
} from './history.js';
import {
  BlockReader,
  RpcBudgetExhausted,
  RpcRateLimited,
  findBlockAtOrBefore,
} from './rpc.js';
import {type CollectorState, CollectorStore} from './storage.js';

export type CollectorEnv = {
  GAS_HISTORY: KVNamespace;
  ETHEREUM_RPC_URL: string;
  RPC_REQUESTS_PER_SECOND: string;
};

function bucketNow(): number {
  return (
    Math.floor(Date.now() / 1000 / SAMPLE_INTERVAL_SECONDS) *
    SAMPLE_INTERVAL_SECONDS
  );
}

export function hasWork(state: CollectorState, end: number): boolean {
  return state.nextForward <= end || state.nextBackward > end - WEEK_SECONDS;
}

export async function collectBatch(
  previous: CollectorState,
  samples: GasSample[],
  reader: BlockReader,
  end: number,
): Promise<{state: CollectorState; added: GasSample[]; error?: unknown}> {
  const state = {...previous};
  const added: GasSample[] = [];
  const present = new Set(samples.map(sample => sample.timestamp));
  const from = end - WEEK_SECONDS;
  state.nextForward = Math.max(
    state.nextForward,
    from + SAMPLE_INTERVAL_SECONDS,
  );

  try {
    const latest = await reader.get('latest');
    const now = Math.floor(Date.now() / 1000);
    if (
      latest.timestamp > now + 60 ||
      latest.timestamp < now - SAMPLE_INTERVAL_SECONDS
    ) {
      throw new Error('Gas sample RPC returned a stale or future block.');
    }

    // The forward cursor always stops at the first uncommitted bucket.
    while (state.nextForward <= end) {
      const target = state.nextForward;
      if (!present.has(target)) {
        const block = await findBlockAtOrBefore(reader, target, latest);
        if (target - block.timestamp >= SAMPLE_INTERVAL_SECONDS) {
          throw new Error(`No fresh block for gas sample ${target}.`);
        }
        added.push({
          timestamp: target,
          blockNumber: block.number.toString(),
          baseFeePerGas: block.baseFeePerGas,
        });
        present.add(target);
      }
      state.nextForward += SAMPLE_INTERVAL_SECONDS;
    }

    let upper = latest;
    while (state.nextBackward > from) {
      const target = state.nextBackward;
      if (!present.has(target)) {
        upper = await findBlockAtOrBefore(reader, target, upper);
        if (target - upper.timestamp >= SAMPLE_INTERVAL_SECONDS) {
          throw new Error(`No fresh block for gas sample ${target}.`);
        }
        added.push({
          timestamp: target,
          blockNumber: upper.number.toString(),
          baseFeePerGas: upper.baseFeePerGas,
        });
        present.add(target);
      }
      state.nextBackward -= SAMPLE_INTERVAL_SECONDS;
    }
    return {state, added};
  } catch (error) {
    return {state, added, error};
  }
}

export class GasCollector {
  private readonly store: CollectorStore;
  private running = false;
  private initializing: Promise<void> | undefined;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: CollectorEnv,
  ) {
    this.store = new CollectorStore(storage);
  }

  async read(): Promise<GasSample[]> {
    if (this.store.getState()) return this.store.getSamples();
    return (
      (await this.env.GAS_HISTORY.get<GasSample[]>(
        'samples:eip155:1',
        'json',
      )) ?? []
    );
  }

  private async initialize(): Promise<void> {
    if (this.store.getState()) return;
    this.initializing ??= (async () => {
      const samples =
        (await this.env.GAS_HISTORY.get<GasSample[]>(
          'samples:eip155:1',
          'json',
        )) ?? [];
      const end = bucketNow();
      const last = samples.at(-1)?.timestamp;
      this.store.commit(
        {
          nextForward:
            last === undefined ? end : last + SAMPLE_INTERVAL_SECONDS,
          nextBackward: (last ?? end) - SAMPLE_INTERVAL_SECONDS,
          retryCount: 0,
          notBefore: 0,
        },
        samples,
        end - WEEK_SECONDS,
      );
      console.info('Gas history initialized', {
        imported: samples.length,
        first: samples[0]?.timestamp,
        last,
      });
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  async wake(): Promise<void> {
    await this.initialize();
    if (this.running) return;
    const state = this.store.getState()!;
    if (!hasWork(state, bucketNow())) return;
    const due = Math.max(Date.now(), state.notBefore);
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > due) await this.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // This persisted watchdog survives failure between checkpoint and the
      // next alarm. Only alarms modify the collection cursors after migration.
      await this.storage.setAlarm(Date.now() + 120000);
      await this.initialize();
      const previous = this.store.getState()!;
      if (previous.notBefore > Date.now()) {
        await this.storage.setAlarm(previous.notBefore);
        return;
      }
      const end = bucketNow();
      if (!hasWork(previous, end)) {
        await this.storage.deleteAlarm();
        return;
      }

      const rate = Number(this.env.RPC_REQUESTS_PER_SECOND);
      if (!Number.isFinite(rate) || rate <= 0)
        throw new Error('Invalid RPC_REQUESTS_PER_SECOND.');
      const reader = new BlockReader(this.env.ETHEREUM_RPC_URL, {
        requestIntervalMs: Math.ceil(1000 / rate),
        nextRequestAt: previous.notBefore,
      });
      const {state, added, error} = await collectBatch(
        previous,
        this.store.getSamples(),
        reader,
        end,
      );
      const failed =
        error !== undefined && !(error instanceof RpcBudgetExhausted);
      state.retryCount = failed ? previous.retryCount + 1 : 0;
      state.notBefore = failed
        ? Math.max(
            reader.nextRequestAt,
            Date.now() +
              Math.min(300000, 5000 * 2 ** Math.min(state.retryCount - 1, 6)),
            error instanceof RpcRateLimited ? error.retryAt : 0,
          )
        : reader.nextRequestAt;

      this.store.commit(state, added, end - WEEK_SECONDS);
      const pending = hasWork(state, bucketNow());
      if (pending)
        await this.storage.setAlarm(Math.max(Date.now(), state.notBefore));
      else await this.storage.deleteAlarm();

      console.info('Gas history collection', {
        added: added.length,
        forward: added.filter(
          sample => sample.timestamp >= previous.nextForward,
        ).length,
        backfilled: added.filter(
          sample => sample.timestamp < previous.nextForward,
        ).length,
        sampleCount: this.store.getSamples().length,
        nextForward: state.nextForward,
        nextBackward: state.nextBackward,
        rpcRequests: reader.requests,
        pending,
        retryCount: state.retryCount,
        nextRunAt: pending ? state.notBefore : null,
      });
      if (failed)
        console.error(
          'Gas history collection will retry from its saved cursors.',
          error,
        );
    } finally {
      this.running = false;
    }
  }
}
