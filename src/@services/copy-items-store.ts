import type {CopyItemsState} from '../@components/views/safe/index.js';

/** In-memory flows survive route remounts without retaining PIN sessions. */
export class CopyItemsStore {
  private readonly flows = new Map<string, CopyItemsState>();

  get(id: string): CopyItemsState | undefined {
    return this.flows.get(id);
  }

  getOrCreate(id: string, create: () => CopyItemsState): CopyItemsState {
    let flow = this.flows.get(id);
    if (!flow) {
      flow = create();
      this.flows.set(id, flow);
    }
    return flow;
  }
}
