# Monoid gas history

Cloudflare Worker for the APP's historical Ethereum base-fee comparison. This
independent package does not participate in the Android or Vite build.

## Collection

Ethereum mainnet (`eip155:1`) is sampled at five-minute boundaries. Each sample
uses the last block at or before that boundary, with the real block number and
base fee in decimal wei. A block more than five minutes old at the boundary is
rejected. The timestamp search uses actual block timestamps; its initial
12-second estimate does not assume every slot produced a block.

A single SQLite Durable Object owns the samples and two persistent cursors:

- `nextForward` is the next unprocessed regular sampling bucket. Every run starts
  there and proceeds chronologically to the current bucket. Delayed or failed
  runs never jump directly to the latest bucket. Buckets outside seven-day
  retention are no longer needed and may be skipped.
- `nextBackward` is the next historical bucket to collect. It moves backward
  through the required seven-day window, preserving existing samples. Historical
  collection runs continuously at the configured RPC rate until it is complete.

Cron wakes the collector every five minutes. While either cursor has work,
Durable Object alarms start successive batches immediately; historical progress
is not limited to one small batch per Cron invocation. Regular catch-up takes
priority before historical collection in each batch. Once both cursors are
caught up, alarms stop and the next Cron wakes regular collection.

Each batch makes at most 40 RPC requests and has a 90-second RPC deadline, with a
10-second timeout per request. These are checkpoint boundaries, not rate limits:
the next batch resumes without waiting five minutes. `RPC_REQUESTS_PER_SECOND`
sets the actual request rate (default 0.5, or one request every two seconds).
Requests are serial and spaced, with
spacing preserved between batches. This default is a conservative local setting,
not a claimed PublicNode quota. HTTP 429 respects `Retry-After`; other failures
use exponential backoff from 5 seconds to 5 minutes.

New samples, retention deletion and both cursors commit in one SQLite transaction.
A failed historical or regular request leaves that bucket's cursor unchanged;
successfully completed buckets are saved before retry. Duplicate samples never
overwrite existing values. A persisted watchdog alarm recovers from interruption
between a checkpoint and scheduling the next batch. HTTP readers only access
committed data and never start Ethereum RPC work.

At first wake, the collector imports the existing `samples:eip155:1` KV value.
Existing samples retain their original values. Thereafter SQLite is authoritative;
the old KV namespace is retained solely for migration and is no longer written.
Before initial migration, HTTP reads can still serve that existing KV snapshot.

## Comparison and API

`GET /api/gas-history/eip155:1` returns:

- `chainId`, `metric: "baseFeePerGas"`, `sampleIntervalSeconds: 300`;
- `updatedAt`: the most recent actual sample's Unix timestamp, or null;
- `windows["24h"]` and `windows["7d"]`: `from`, `to`, `sampleCount`,
  `expectedSampleCount`, `status`, `p25`, and `p75`.

Each window's lower boundary is exclusive and upper boundary inclusive. A window
is `ready` only with at least 90% of its expected samples and samples within
15 minutes of both ends. Otherwise it is `collecting` with null thresholds.
P25/P75 are non-negative decimal strings in wei. Five-minute sampling approximates
the time distribution; brief spikes between samples are not retained.

The endpoint supports GET, HEAD, OPTIONS and public CORS. Unsupported paths return 404. It has no HTTP write or transaction-submission routes. Workers Cache may
serve responses for 60 seconds; `updatedAt` is not advanced by a read. The APP
rejects history older than 15 minutes and continues to obtain current transaction
fees from its own RPC provider.

## Local development

Requires Node.js 22 or later. In this directory:

```sh
npm ci
npm test
npm run lint
```

Copy `.dev.vars.example` to `.dev.vars` and set `ETHEREUM_RPC_URL` to an Ethereum
RPC serving at least seven days of block history. The file is ignored by Git.

```sh
npm run dev
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
curl "http://127.0.0.1:8787/api/gas-history/eip155:1"
```

The local scheduled route wakes the collector; its alarms continue historical
collection. Collection logs expose added samples, forward/backward progress,
both cursors, sample count, request count, pending work and retry state.

## Deployment

The Worker is `monoid-gas-history`, routed only at
`www.monoid.app/api/gas-history/*`. Existing website redirects must exclude
`/api/`. `wrangler.jsonc` binds `GAS_COLLECTOR` to the SQLite class
`GasHistoryCollector`; migration `v1` creates it. Do not reset this namespace on
redeploy: it contains both history and durable cursors.

`ETHEREUM_RPC_URL` is a Worker secret, currently pointing at
`https://ethereum-rpc.publicnode.com`. `RPC_REQUESTS_PER_SECOND` is a configurable
Worker variable. Updating these does not require APP changes.

Wrangler is authenticated in WSL on the current machine. Keep its credentials
there and run the Linux Wrangler from outside the Windows dependency tree:

```sh
cd /tmp
npx --yes wrangler@4.151.1 deploy \
  --config /mnt/c/Projects/monoid/workers/gas-history/wrangler.jsonc
```

For local bundle validation, run in this package directory:

```sh
npx wrangler deploy --dry-run --outdir .bld/bundle
```

After deployment, verify migration, successful alarm batches running between
Cron invocations, increasing sample counts and both windows becoming ready.
Once history is complete, verify that a subsequent Cron resumes from the saved
forward cursor and preserves complete coverage.

The public endpoint is `https://www.monoid.app/api/gas-history/eip155:1`. The APP's
`VITE_GAS_HISTORY_URL` remains `https://www.monoid.app/api`; the service appends
`/gas-history/eip155:1`. Local development can use `http://127.0.0.1:8787/api`.
