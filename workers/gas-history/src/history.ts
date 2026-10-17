export const CHAIN_ID = 'eip155:1';
export const SAMPLE_INTERVAL_SECONDS = 300;
export const DAY_SECONDS = 24 * 60 * 60;
export const WEEK_SECONDS = 7 * DAY_SECONDS;

export type GasSample = {
  timestamp: number;
  blockNumber: string;
  baseFeePerGas: string;
};

export type GasHistoryWindow = {
  from: number;
  to: number;
  sampleCount: number;
  expectedSampleCount: number;
  status: 'ready' | 'collecting';
  p25: string | null;
  p75: string | null;
};

export type GasHistory = {
  chainId: typeof CHAIN_ID;
  metric: 'baseFeePerGas';
  sampleIntervalSeconds: number;
  updatedAt: number | null;
  windows: Record<'24h' | '7d', GasHistoryWindow>;
};

export function summarizeWindow(
  samples: GasSample[],
  duration: number,
  now: number,
): GasHistoryWindow {
  const from = now - duration;
  const values = samples.filter(
    sample => sample.timestamp > from && sample.timestamp <= now,
  );
  const expectedSampleCount = duration / SAMPLE_INTERVAL_SECONDS;
  // Tolerate missed runs, but require samples spanning the whole window.
  const ready =
    values.length >= Math.ceil(expectedSampleCount * 0.9) &&
    values[0]!.timestamp <= from + 3 * SAMPLE_INTERVAL_SECONDS &&
    values.at(-1)!.timestamp >= now - 3 * SAMPLE_INTERVAL_SECONDS;
  const fees = ready
    ? values
        .map(sample => BigInt(sample.baseFeePerGas))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : [];

  return {
    from,
    to: now,
    sampleCount: values.length,
    expectedSampleCount,
    status: ready ? 'ready' : 'collecting',
    p25: ready ? fees[Math.ceil(fees.length * 0.25) - 1]!.toString() : null,
    p75: ready ? fees[Math.ceil(fees.length * 0.75) - 1]!.toString() : null,
  };
}

export function summarizeHistory(
  samples: GasSample[],
  now: number,
): GasHistory {
  const updatedAt = samples.at(-1)?.timestamp ?? null;
  const end =
    Math.floor(now / SAMPLE_INTERVAL_SECONDS) * SAMPLE_INTERVAL_SECONDS;

  return {
    chainId: CHAIN_ID,
    metric: 'baseFeePerGas',
    sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
    updatedAt,
    windows: {
      '24h': summarizeWindow(samples, DAY_SECONDS, end),
      '7d': summarizeWindow(samples, WEEK_SECONDS, end),
    },
  };
}
