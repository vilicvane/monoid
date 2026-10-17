import {DurableObject} from 'cloudflare:workers';

import {serveHistory} from './api.js';
import {type CollectorEnv, GasCollector} from './collector.js';
import {CHAIN_ID, type GasSample} from './history.js';

type Env = CollectorEnv & {
  GAS_COLLECTOR: DurableObjectNamespace<GasHistoryCollector>;
};

export class GasHistoryCollector extends DurableObject<Env> {
  private readonly collector: GasCollector;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.collector = new GasCollector(ctx.storage, env);
  }

  async read(): Promise<GasSample[]> {
    return this.collector.read();
  }

  async wake(): Promise<void> {
    await this.collector.wake();
  }

  async alarm(): Promise<void> {
    await this.collector.alarm();
  }
}

export default {
  async fetch(request, env) {
    return serveHistory(request, () =>
      env.GAS_COLLECTOR.getByName(CHAIN_ID).read(),
    );
  },
  async scheduled(_event, env) {
    await env.GAS_COLLECTOR.getByName(CHAIN_ID).wake();
  },
} satisfies ExportedHandler<Env>;
