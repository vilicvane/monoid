# Monoid gas history

Cloudflare Worker for the APP's historical base-fee comparison. It is an
independent package in the Monoid repository; its dependencies and deployment do
not participate in the Android or Vite build.

## Sampling and comparison

- Ethereum mainnet (`eip155:1`) is the initial allowlist.
- One scheduled run every five minutes reads the latest block from the configured
  Ethereum RPC. The planned run time determines the sample bucket; the block
  timestamp is checked for freshness.
- Workers KV retains seven days of decimal-string base-fee samples. The scheduled
  handler is the only writer; HTTP readers never trigger RPC requests.
- The response contains rolling 24-hour and seven-day P25/P75 thresholds. A
  window is ready with at least 90% of its expected samples and samples within
  15 minutes of both ends. Otherwise its status is `collecting`, with null
  thresholds. A fresh deployment accumulates its own history; it does not label
  a short bootstrap window as a complete day.
- Sampling is an approximation of the distribution over time. Brief spikes
  between samples are not retained. KV is eventually consistent; missing samples
  are reflected in `sampleCount` and the coverage checks.
- Workers Cache serves the public response for up to 60 seconds. `updatedAt`
  always identifies the last actual sample, not the time the response was read.
  Consumers must reject stale history. The APP uses a 15-minute freshness limit.
- Only the APP's historical comparison uses this data. Current transaction fees
  continue to come from its RPC provider.

## Local development

Requires Node.js 22 or later. Run these commands in this directory:

```sh
npm ci
npm test
npm run lint
```

Copy `.dev.vars.example` to `.dev.vars` and set `ETHEREUM_RPC_URL` to an Ethereum
mainnet RPC endpoint. `.dev.vars` is ignored by Git. Then run:

```sh
npm run dev
```

The default local endpoint is
`http://127.0.0.1:8787/api/gas-history/eip155:1`. In local development only, a sample
can be collected by requesting:

```sh
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
```

## API

`GET /api/gas-history/eip155:1` returns JSON with:

- `chainId`, `metric: "baseFeePerGas"`, and `sampleIntervalSeconds: 300`;
- `updatedAt`: Unix seconds, or null before the first sample;
- `windows["24h"]` and `windows["7d"]`: `from`, `to` (Unix seconds),
  `sampleCount`, `expectedSampleCount`, `status`, `p25`, and `p75`.

Thresholds are non-negative decimal strings in wei. The lower boundary of each
window is exclusive; the upper boundary is inclusive. Unsupported paths return 404. The endpoint supports GET, HEAD, OPTIONS and public CORS; it has no
user-specific data or transaction submission routes.

## Deployment

The deployed Worker is `monoid-gas-history`, with a dedicated KV namespace and
the route `www.monoid.app/api/gas-history/*`. Other website routes are not handled
by this Worker. Existing redirect rules must exclude `/api/` so these requests
can reach the Worker.

`ETHEREUM_RPC_URL` is stored as a Worker secret. It currently uses the public
Ethereum mainnet endpoint `https://ethereum-rpc.publicnode.com`. To replace the
provider, update this secret; APP changes are not required.

On the current development machine, Wrangler is authenticated in WSL. Run
deployment commands there, without copying its OAuth credentials to Windows.
From this directory:

```sh
npx wrangler login
npx wrangler secret put ETHEREUM_RPC_URL
npm run deploy
```

For a new deployment account, create a dedicated namespace with
`npx wrangler kv namespace create GAS_HISTORY`, then update the account, route,
and namespace ID in `wrangler.jsonc` before deploying.

The public endpoint is `https://www.monoid.app/api/gas-history/eip155:1`.
Check its response and the scheduled-run logs. Set the APP's
`VITE_GAS_HISTORY_URL` to `https://www.monoid.app/api`, or
`http://127.0.0.1:8787/api` for local development. The service appends
`/gas-history/eip155:1` to this API base URL. Restart Vite or rebuild the APP after
changing this build-time variable. Without a configured URL, the APP continues
to display current fees and leaves the historical comparison unavailable.

A deployment bundle can be checked without publishing:

```sh
npx wrangler deploy --dry-run --outdir .bld/bundle
```
