import {type GasSample} from './history.js';

export type CollectorState = {
  nextForward: number;
  nextBackward: number;
  retryCount: number;
  notBefore: number;
};

export class CollectorStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        timestamp INTEGER PRIMARY KEY,
        block_number TEXT NOT NULL,
        base_fee_per_gas TEXT NOT NULL
      )
    `);
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collector_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_forward INTEGER NOT NULL,
        next_backward INTEGER NOT NULL,
        retry_count INTEGER NOT NULL,
        not_before INTEGER NOT NULL
      )
    `);
  }

  getState(): CollectorState | undefined {
    return this.storage.sql
      .exec<CollectorState>(
        `
        SELECT next_forward AS nextForward, next_backward AS nextBackward,
          retry_count AS retryCount, not_before AS notBefore
        FROM collector_state WHERE id = 1
      `,
      )
      .toArray()[0];
  }

  getSamples(): GasSample[] {
    return this.storage.sql
      .exec<GasSample>(
        `
        SELECT timestamp, block_number AS blockNumber,
          base_fee_per_gas AS baseFeePerGas
        FROM samples ORDER BY timestamp
      `,
      )
      .toArray();
  }

  commit(
    state: CollectorState,
    samples: GasSample[],
    retainAfter: number,
  ): void {
    this.storage.transactionSync(() => {
      for (const sample of samples) {
        this.storage.sql.exec(
          `INSERT INTO samples (timestamp, block_number, base_fee_per_gas)
           VALUES (?, ?, ?) ON CONFLICT (timestamp) DO NOTHING`,
          sample.timestamp,
          sample.blockNumber,
          sample.baseFeePerGas,
        );
      }

      this.storage.sql.exec(
        'DELETE FROM samples WHERE timestamp <= ?',
        retainAfter,
      );
      this.storage.sql.exec(
        `INSERT INTO collector_state
           (id, next_forward, next_backward, retry_count, not_before)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           next_forward = excluded.next_forward,
           next_backward = excluded.next_backward,
           retry_count = excluded.retry_count,
           not_before = excluded.not_before`,
        state.nextForward,
        state.nextBackward,
        state.retryCount,
        state.notBefore,
      );
    });
  }
}
