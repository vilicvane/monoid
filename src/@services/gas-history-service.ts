import ms from 'ms';

const CACHE_DURATION = ms('5m');
const REQUEST_TIMEOUT = ms('10s');
export const GAS_HISTORY_MAX_AGE_SECONDS = 15 * 60;

export type GasHistoryWindow = {
  from: number;
  to: number;
  sampleCount: number;
  expectedSampleCount: number;
} & (
  | {status: 'ready'; p25: string; p75: string}
  | {status: 'collecting'; p25: null; p75: null}
);

export type GasHistory = {
  chainId: 'eip155:1';
  metric: 'baseFeePerGas';
  sampleIntervalSeconds: 300;
  updatedAt: number | null;
  windows: {'24h': GasHistoryWindow; '7d': GasHistoryWindow};
};

export class GasHistoryService {
  private cache: {value: GasHistory; expiresAt: number} | undefined;
  private loading: Promise<GasHistory | undefined> | undefined;

  constructor(private baseUrl?: string) {}

  supports(chainId: string): boolean {
    return chainId === 'eip155:1';
  }

  getHistory(chainId: string): Promise<GasHistory | undefined> {
    if (!this.baseUrl || !this.supports(chainId)) {
      return Promise.resolve(undefined);
    }
    if (this.loading) return this.loading;
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return Promise.resolve(
        isFresh(this.cache.value) ? this.cache.value : undefined,
      );
    }

    this.loading = this.loadHistory()
      .catch(() => undefined)
      .finally(() => {
        this.loading = undefined;
      });

    return this.loading;
  }

  private async loadHistory(): Promise<GasHistory | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(
        `${this.baseUrl!.replace(/\/$/, '')}/gas-history/eip155:1`,
        {signal: controller.signal},
      );
      if (!response.ok) return undefined;

      const value = parseHistory(await response.json());
      if (!value || !isFresh(value)) return undefined;

      this.cache = {value, expiresAt: Date.now() + CACHE_DURATION};
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseHistory(value: unknown): GasHistory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const history = value as GasHistory;

  if (
    history.chainId !== 'eip155:1' ||
    history.metric !== 'baseFeePerGas' ||
    history.sampleIntervalSeconds !== 300 ||
    (history.updatedAt !== null && !isTimestamp(history.updatedAt)) ||
    !isWindow(history.windows?.['24h'], 288) ||
    !isWindow(history.windows?.['7d'], 2016) ||
    (history.updatedAt === null &&
      Object.values(history.windows).some(window => window.status === 'ready'))
  ) {
    return undefined;
  }

  return history;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isWindow(value: unknown, expectedSampleCount: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const window = value as GasHistoryWindow;

  if (
    !isTimestamp(window.from) ||
    !isTimestamp(window.to) ||
    window.to - window.from !== expectedSampleCount * 300 ||
    !Number.isSafeInteger(window.sampleCount) ||
    window.sampleCount < 0 ||
    window.sampleCount > expectedSampleCount ||
    window.expectedSampleCount !== expectedSampleCount
  ) {
    return false;
  }

  if (window.status === 'collecting') {
    return window.p25 === null && window.p75 === null;
  }

  return (
    window.status === 'ready' &&
    window.sampleCount > 0 &&
    typeof window.p25 === 'string' &&
    /^(0|[1-9]\d*)$/.test(window.p25) &&
    typeof window.p75 === 'string' &&
    /^(0|[1-9]\d*)$/.test(window.p75) &&
    BigInt(window.p25) <= BigInt(window.p75)
  );
}

function isFresh(history: GasHistory): boolean {
  const now = Math.floor(Date.now() / 1000);
  const earliest = now - GAS_HISTORY_MAX_AGE_SECONDS;

  return (
    (history.updatedAt === null ||
      (history.updatedAt >= earliest && history.updatedAt <= now)) &&
    Object.values(history.windows).every(
      window => window.to >= earliest && window.to <= now,
    )
  );
}
