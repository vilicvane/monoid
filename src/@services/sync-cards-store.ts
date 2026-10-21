import type {SyncCardsState} from '../@components/views/safe/index.js';

/** In-memory card contents survive route remounts; PINs belong to the view. */
export class SyncCardsStore {
  private readonly flows = new Map<string, SyncCardsState>();

  getOrCreate(id: string, create: () => SyncCardsState): SyncCardsState {
    let flow = this.flows.get(id);
    if (!flow) {
      flow = create();
      this.flows.set(id, flow);
    }
    return flow;
  }
}
