import {computed, observable, runInAction} from 'mobx';

import {MonoidIdHex, MonoidPIN, PublicKeyHex} from '../../../../@atomics.js';
import {CardItemNotFoundError} from '../../../../@lib/cbor-applet.js';
import {
  type CardItem,
  CardItemConflictError,
  type CardItemIssue,
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  MultiCardSeries,
  acceptMatchingItem,
  assertCardPINNotBlocked,
  assertSameCardWithBundle,
  authenticateCardPIN,
  cardItemIssue,
  monoidCommandDefinitions,
  readBackupCardIdentity,
  readCardContents,
} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import {
  type CardMaintenanceBundleRecovery,
  assertCardMaintenanceBundleRecovery,
} from '../../../../@services/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../../@utils/index.js';
import {xCBOR} from '../../../../@x-value/index.js';
import {readOpaqueCardItem} from '../card-contents.js';
import {mergeCardItemData} from '../card-item-merge.js';
import type {ScannedCardData} from '../common.js';

import {
  type CardSyncIdentity,
  type CardSyncItem,
  type CardSyncOperation,
  type CardSyncPlan,
  type CardSyncSnapshot,
  createCardSyncPlans,
  sameCardSyncItem,
} from './card-sync-plan.js';

export type {CardSyncIdentity, CardSyncItem} from './card-sync-plan.js';

export type CardSyncProgress = {
  stage: 'reading' | 'exporting' | 'checking' | 'writing';
  current: number;
  total: number;
};

export type CardSyncCard = CardSyncSnapshot & {
  complete: boolean;
  completed: number;
  total: number;
};

type Execution = {
  plan: CardSyncPlan;
  expected: CardSyncSnapshot;
  next: number;
  pending?: CardSyncOperation;
};

type ProgressCallback = (progress: CardSyncProgress) => void;

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Card sync cancelled'), {code: 'CANCELLED'});
  }
}

function changed(): never {
  throw new MonoidCardError('Card changed, start sync again');
}

function snapshot(card: CardSyncSnapshot): ScannedCardData {
  return {
    id: MonoidIdHex.satisfies(card.id),
    publicKey: PublicKeyHex.satisfies(card.publicKey),
    bundle: card.bundle,
    alias: card.alias ?? false,
    allowPeerExtension: card.allowPeerExtension ?? false,
    authority: card.authority ?? false,
    items: card.items.map(
      ({data: _data, exported: _exported, ...item}) => item,
    ),
  };
}

function replaceItem(
  card: CardSyncSnapshot,
  item: CardSyncItem,
): CardSyncSnapshot {
  const exists = card.items.some(current => current.index === item.index);

  return {
    ...card,
    items: exists
      ? card.items.map(current =>
          current.index === item.index ? item : current,
        )
      : [...card.items, item],
  };
}

export async function authenticateCardSync(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  pin: string | undefined,
  signal: AbortSignal,
  onAuthenticated?: () => void,
): Promise<void> {
  if (hello.pins.secret === false)
    throw new MonoidCardError('Secret PIN not set');
  assertCardPINNotBlocked(hello, 'secret');
  if (pin === undefined) throw new MonoidCardError('Enter Secret PIN');
  if (!MonoidPIN.is(pin)) {
    throw new MonoidCardError('Secret PIN must contain 6 to 16 characters');
  }

  cancelled(signal);

  await authenticateCardPIN(applet, pin);

  cancelled(signal);
  onAuthenticated?.();
}

function operationRequest(operation: CardSyncOperation): {
  index: Uint8Array;
  metadata?: Uint8Array;
  alias?: string;
  data?: Uint8Array;
  secret?: false;
} {
  const {after} = operation;
  const index = hexToUint8Array(after.index);

  switch (operation.kind) {
    case 'import': {
      const exported = operation.exported!;
      return {
        index,
        ...(exported.metadata !== undefined && {
          metadata: hexToUint8Array(exported.metadata),
        }),
        ...(exported.alias !== undefined && {alias: exported.alias}),
        data: hexToUint8Array(exported.data),
      };
    }
    case 'create':
      return {
        index,
        ...(after.metadata !== undefined && {
          metadata: hexToUint8Array(after.metadata),
        }),
        ...(after.alias !== undefined && {alias: after.alias}),
        data: hexToUint8Array(after.data!),
        secret: false,
      };
    case 'data':
      return {index, data: hexToUint8Array(after.data!)};
    case 'alias':
      return {index, alias: after.alias};
  }
}

async function execute(
  applet: MonoidApplet,
  operation: CardSyncOperation,
  signal: AbortSignal,
): Promise<void> {
  const request = operationRequest(operation);
  const expected = {
    ...operation.after,
    index: hexToUint8Array(operation.after.index),
    metadata:
      operation.after.metadata === undefined
        ? undefined
        : hexToUint8Array(operation.after.metadata),
    data:
      operation.after.data === undefined
        ? undefined
        : hexToUint8Array(operation.after.data),
  };

  try {
    switch (operation.kind) {
      case 'import':
        await applet.importItem(
          monoidCommandDefinitions.importItem.request.satisfies(request),
        );
        break;
      case 'create': {
        const result = await applet.create(
          monoidCommandDefinitions.create.request.satisfies(request),
        );
        if (uint8ArrayToHex(result.index) !== operation.after.index) changed();
        break;
      }
      case 'data':
      case 'alias':
        await applet.set(
          monoidCommandDefinitions.set.request.satisfies(request),
        );
        break;
    }
  } catch (error) {
    if (operation.kind !== 'import' && operation.kind !== 'create') throw error;
    await acceptMatchingItem(applet, expected, error, signal);
  }
}

/** One in-memory collection and fixed write plan; never retains PINs. */
export class CardSyncSession {
  private readonly current = observable.box<{
    cards: CardSyncCard[];
    phase: 'collect' | 'write' | 'complete';
    progress?: CardSyncProgress;
    confirmedSnapshot?: ScannedCardData;
  }>({cards: [], phase: 'collect'}, {deep: false});
  private readonly running = observable.box(false);
  private executions = new Map<string, Execution>();
  private readonly collectionPlan = computed<
    {plans: CardSyncPlan[]} | {error: unknown}
  >(() => {
    try {
      return {plans: createCardSyncPlans(this.cards)};
    } catch (error) {
      // Keep planning failures in the explicit Continue action, out of rendering.
      return {error};
    }
  });

  get cards(): readonly CardSyncCard[] {
    return this.current.get().cards;
  }

  get series(): MultiCardSeries {
    return MultiCardSeries.from(this.cards);
  }

  get phase(): 'collect' | 'write' | 'complete' {
    return this.current.get().phase;
  }
  get busy(): boolean {
    return this.running.get();
  }
  get progress(): CardSyncProgress | undefined {
    return this.current.get().progress;
  }
  get confirmedSnapshot(): ScannedCardData | undefined {
    return this.current.get().confirmedSnapshot;
  }
  get noSyncRequired(): boolean {
    if (this.phase !== 'collect' || this.cards.length < 2) return false;
    const preview = this.collectionPlan.get();
    return (
      'plans' in preview &&
      preview.plans.every(
        plan => plan.operations.length === 0 && plan.issues.length === 0,
      )
    );
  }

  private update(value: Partial<ReturnType<typeof this.current.get>>): void {
    runInAction(() => this.current.set({...this.current.get(), ...value}));
  }

  private report(value: CardSyncProgress, callback?: ProgressCallback): void {
    this.update({progress: value});
    callback?.(value);
  }

  private finish(cards: CardSyncCard[]): void {
    if (MultiCardSeries.from(cards).completedCount === cards.length) {
      this.executions.clear();
      this.update({
        phase: 'complete',
        cards: cards.map(card => ({
          ...card,
          items: card.items.map(({exported: _exported, ...item}) => item),
        })),
      });
    } else {
      this.update({cards, phase: 'write'});
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new MonoidCardError('Card sync is in progress');
    runInAction(() => this.running.set(true));

    try {
      return await operation();
    } finally {
      runInAction(() => this.running.set(false));
    }
  }

  private async read(
    applet: MonoidApplet,
    identity: CardSyncIdentity,
    signal: AbortSignal,
    stage: 'reading' | 'checking',
    callback?: ProgressCallback,
    listed?: Awaited<ReturnType<MonoidApplet['list']>>,
  ): Promise<CardSyncSnapshot> {
    const issues: CardItemIssue[] = [];
    const {items} = await readCardContents(
      applet,
      entry => readOpaqueCardItem(applet, entry),
      {
        listed,
        onItemError: (item, error) => {
          const issue = cardItemIssue(item.index, error);
          if (!issue) throw error;
          issues.push(issue);
          return item;
        },
        check: () => cancelled(signal),
        onProgress: (current, total) =>
          this.report({stage, current, total}, callback),
      },
    );

    return {...identity, items, issues};
  }

  async add(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    signal: AbortSignal,
    secretPIN?: string,
    onProgress?: ProgressCallback,
    onAuthenticated?: () => void,
  ): Promise<CardSyncCard> {
    return this.exclusive(async () => {
      if (this.phase !== 'collect')
        throw new MonoidCardError('Start sync again to add cards');
      const identity = readBackupCardIdentity(hello);
      await authenticateCardSync(
        applet,
        hello,
        secretPIN,
        signal,
        onAuthenticated,
      );
      const read = await this.read(
        applet,
        identity,
        signal,
        'reading',
        onProgress,
      );
      const secrets =
        identity.bundle === false ? [] : read.items.filter(item => item.secret);
      let exported = 0;

      for (const item of read.items) {
        if (!item.secret || identity.bundle === false) continue;
        cancelled(signal);
        this.report(
          {stage: 'exporting', current: exported, total: secrets.length},
          onProgress,
        );
        let result: Awaited<ReturnType<MonoidApplet['exportItem']>>;
        try {
          result = await applet.exportItem({
            index: hexToUint8Array(item.index),
          });
        } catch (error) {
          const issue = cardItemIssue(item.index, error);
          if (!issue) throw error;
          read.issues!.push(issue);
          cancelled(signal);
          this.report(
            {stage: 'exporting', current: ++exported, total: secrets.length},
            onProgress,
          );
          continue;
        }
        const artifact = {
          metadata:
            result.metadata === undefined
              ? undefined
              : uint8ArrayToHex(result.metadata),
          alias: result.alias,
          data: uint8ArrayToHex(result.data),
        };
        if (
          artifact.metadata !== item.metadata ||
          artifact.alias !== item.alias
        )
          changed();
        item.exported = artifact;
        this.report(
          {stage: 'exporting', current: ++exported, total: secrets.length},
          onProgress,
        );
      }

      cancelled(signal);
      const card: CardSyncCard = {
        ...read,
        complete: false,
        completed: 0,
        total: 0,
      };
      const exists = this.cards.some(
        existing => existing.publicKey === card.publicKey,
      );
      this.update({
        cards: exists
          ? this.cards.map(existing =>
              existing.publicKey === card.publicKey ? card : existing,
            )
          : [...this.cards, card],
        confirmedSnapshot: snapshot(card),
      });
      return card;
    });
  }

  remove(publicKey: string): void {
    if (this.busy || this.phase !== 'collect')
      throw new MonoidCardError('Card list is fixed');
    this.update({
      cards: this.cards.filter(card => card.publicKey !== publicKey),
    });
  }

  prepare(): void {
    if (this.busy || this.phase !== 'collect')
      throw new MonoidCardError('Card sync is in progress');
    if (this.cards.length < 2) throw new MonoidCardError('Add another card');
    const preview = this.collectionPlan.get();
    if ('error' in preview) throw preview.error;
    const {plans} = preview;

    for (const plan of plans) {
      for (const operation of plan.operations) {
        const request = operationRequest(operation);
        const length =
          operation.kind === 'import'
            ? monoidCommandDefinitions.importItem.request.encode(
                xCBOR,
                monoidCommandDefinitions.importItem.request.satisfies(request),
              ).length
            : operation.kind === 'create'
              ? monoidCommandDefinitions.create.request.encode(
                  xCBOR,
                  monoidCommandDefinitions.create.request.satisfies(request),
                ).length
              : monoidCommandDefinitions.set.request.encode(
                  xCBOR,
                  monoidCommandDefinitions.set.request.satisfies(request),
                ).length;
        if (length > 8192) {
          plan.issues.push({index: operation.after.index, reason: 'Too large'});
        }
      }
    }

    for (const plan of plans) {
      plan.operations = plan.operations.filter(
        operation =>
          !plan.issues.some(issue => issue.index === operation.after.index),
      );
    }

    this.executions = new Map(
      plans.map(plan => [
        plan.card.publicKey,
        {
          plan,
          expected: plan.card,
          next: 0,
        },
      ]),
    );
    const cards = plans.map(plan => ({
      ...plan.card,
      issues: plan.issues,
      total: new Set(plan.operations.map(operation => operation.after.index))
        .size,
      completed: 0,
      complete: plan.operations.length === 0,
    }));
    this.finish(cards);
  }

  private acknowledge(
    execution: Execution,
    operation: CardSyncOperation,
    issue?: CardItemIssue,
  ): void {
    if (!issue)
      execution.expected = replaceItem(execution.expected, operation.after);
    execution.next++;
    if (issue) {
      execution.expected = {
        ...execution.expected,
        issues: [...(execution.expected.issues ?? []), issue],
      };
      execution.plan.operations = execution.plan.operations.filter(
        (next, index) =>
          index < execution.next || next.after.index !== issue.index,
      );
    }
    execution.pending = undefined;
    const remaining = new Set(
      execution.plan.operations
        .slice(execution.next)
        .map(item => item.after.index),
    );
    const finished = new Set(
      execution.plan.operations
        .slice(0, execution.next)
        .map(item => item.after.index)
        .filter(index => !remaining.has(index)),
    );
    this.update({
      cards: this.cards.map(card =>
        card.publicKey === execution.expected.publicKey
          ? {
              ...card,
              items: execution.expected.items,
              issues: issue ? [...(card.issues ?? []), issue] : card.issues,
              completed: finished.size,
            }
          : card,
      ),
      confirmedSnapshot: snapshot(execution.expected),
    });
  }

  private async reconcilePending(
    applet: MonoidApplet,
    execution: Execution,
    signal: AbortSignal,
    onProgress?: ProgressCallback,
  ): Promise<void> {
    const pending = execution.pending;
    if (!pending) return;

    cancelled(signal);
    this.report({stage: 'checking', current: 0, total: 1}, onProgress);

    const index = hexToUint8Array(pending.after.index);
    let entry: Awaited<ReturnType<MonoidApplet['view']>> | undefined;

    try {
      entry = await applet.view({index});
    } catch (error) {
      if (!(error instanceof CardItemNotFoundError)) {
        throw error;
      }
    }

    cancelled(signal);
    const found = entry
      ? (
          await this.read(
            applet,
            execution.expected,
            signal,
            'checking',
            onProgress,
            {
              items: [
                {
                  index,
                  ...entry,
                  type: pending.after.type as CardItem['type'],
                },
              ],
            },
          )
        ).items[0]
      : undefined;

    if (sameCardSyncItem(found, pending.after))
      this.acknowledge(execution, pending);
    else if (sameCardSyncItem(found, pending.before))
      execution.pending = undefined;
    else changed();

    this.report({stage: 'checking', current: 1, total: 1}, onProgress);
  }

  async write(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    signal: AbortSignal,
    secretPIN?: string,
    onProgress?: ProgressCallback,
    onAuthenticated?: () => void,
  ): Promise<CardSyncCard> {
    return this.exclusive(async () => {
      if (this.phase === 'collect')
        throw new MonoidCardError('Prepare sync first');
      const identity = readBackupCardIdentity(hello);
      const card = this.cards.find(
        item => item.publicKey === identity.publicKey,
      );
      if (!card) throw new MonoidCardError('Scan a card in this sync');
      assertSameCardWithBundle(hello, card, 'Card changed, start sync again');
      if (this.series.hasFinished(identity.publicKey)) return card;

      const execution = this.executions.get(identity.publicKey)!;
      await authenticateCardSync(
        applet,
        hello,
        secretPIN,
        signal,
        onAuthenticated,
      );
      await this.reconcilePending(applet, execution, signal, onProgress);

      while (execution.next < execution.plan.operations.length) {
        cancelled(signal);
        const operation = execution.plan.operations[execution.next]!;
        const current = this.cards.find(
          item => item.publicKey === identity.publicKey,
        )!;
        this.report(
          {stage: 'writing', current: current.completed, total: current.total},
          onProgress,
        );
        execution.pending = operation;
        try {
          await execute(applet, operation, signal);
        } catch (error) {
          const issue = cardItemIssue(operation.after.index, error);
          if (!issue) throw error;
          this.acknowledge(execution, operation, issue);
          cancelled(signal);
          continue;
        }
        // Save the ACK before checking cancellation or issuing another APDU.
        this.acknowledge(execution, operation);
      }

      // Participating cards are only changed by this flow. Successful command
      // responses advance the snapshot without another full read of the card.
      const cards = this.cards.map(item =>
        item.publicKey === identity.publicKey
          ? {
              ...item,
              items: execution.expected.items,
              complete: true,
              completed: item.total,
            }
          : item,
      );
      this.update({confirmedSnapshot: snapshot(execution.expected)});
      this.finish(cards);
      return this.cards.find(item => item.publicKey === identity.publicKey)!;
    });
  }

  /** The caller authenticates first; only the peer can issue the target's recovery envelopes. */
  async exportRecovery(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    target: CardSyncIdentity,
    signal: AbortSignal,
    onProgress?: ProgressCallback,
    coverage: readonly CardSyncIdentity[] = [target],
  ): Promise<CardMaintenanceBundleRecovery> {
    return this.exclusive(async () => {
      cancelled(signal);
      const identity = readBackupCardIdentity(hello);
      const source = this.cards.find(
        card => card.publicKey === identity.publicKey,
      );
      const destination = this.cards.find(
        card => card.publicKey === target.publicKey,
      );
      if (!source) throw new MonoidCardError('Scan a card in this sync');
      assertSameCardWithBundle(hello, source, 'Card changed, start sync again');
      if (!destination) changed();
      assertSameCardWithBundle(
        target,
        destination,
        'Card changed, start sync again',
      );
      if (!source.complete) throw new MonoidCardError('Sync the card first');
      if (
        identity.bundle === false ||
        identity.bundle !== target.bundle ||
        identity.publicKey === target.publicKey
      )
        throw new MonoidCardError('Scan another card in the same bundle');

      // A peer archive must cover every original target item before deletion.
      // A completed partial sync alone is not proof of a complete recovery.
      for (const required of coverage) {
        const member = this.cards.find(
          card => card.publicKey === required.publicKey,
        );
        if (!member || member.bundle !== target.bundle) changed();
        for (const item of member.items) {
          const peer = source.items.find(
            candidate => candidate.index === item.index,
          );
          try {
            if (
              !peer ||
              (!item.secret && item.data === undefined) ||
              mergeCardItemData(peer, item).data !== peer.data
            )
              throw new CardItemConflictError(item.index);
          } catch (cause) {
            throw new MonoidCardError(
              `Item ${item.index}: incomplete recovery`,
              {
                cause,
              },
            );
          }
        }
      }

      const recovery: CardMaintenanceBundleRecovery = {
        source: {
          id: identity.id,
          publicKey: identity.publicKey,
          bundle: identity.bundle,
        },
        items: [],
      };
      assertCardMaintenanceBundleRecovery(target, recovery);
      this.report(
        {stage: 'exporting', current: 0, total: source.items.length},
        onProgress,
      );
      const issues: CardItemIssue[] = [];
      for (const [position, item] of source.items.entries()) {
        cancelled(signal);
        // Imported items may still cache the target's original envelopes. Fresh
        // peer exports remain valid after the target's Monoid is replaced.
        let exported: Awaited<ReturnType<MonoidApplet['exportItem']>>;
        try {
          exported = await applet.exportItem({
            index: hexToUint8Array(item.index),
          });
        } catch (cause) {
          cancelled(signal);
          if (isOperationCancelled(cause, signal)) throw cause;
          const issue = cardItemIssue(item.index, cause);
          if (issue) {
            issues.push(issue);
            this.report(
              {
                stage: 'exporting',
                current: position + 1,
                total: source.items.length,
              },
              onProgress,
            );
            continue;
          }
          throw new MonoidCardError(
            `Item ${item.index}: cannot export recovery`,
            {cause},
          );
        }
        const archived = {
          index: item.index,
          secret: item.secret,
          key:
            exported.metadata === undefined
              ? undefined
              : uint8ArrayToHex(exported.metadata),
          alias: exported.alias,
          data: uint8ArrayToHex(exported.data),
          ...(item.data !== undefined && {plaintext: item.data}),
        };
        if (archived.key !== item.metadata || archived.alias !== item.alias)
          changed();
        try {
          assertCardMaintenanceBundleRecovery(target, {
            source: recovery.source,
            items: [archived],
          });
        } catch (cause) {
          throw new MonoidCardError(
            `Item ${item.index}: invalid recovery export`,
            {cause},
          );
        }
        recovery.items.push(archived);
        this.report(
          {
            stage: 'exporting',
            current: position + 1,
            total: source.items.length,
          },
          onProgress,
        );
      }
      cancelled(signal);
      if (issues.length)
        throw new MonoidCardError(
          issues
            .map(
              issue =>
                `Item ${issue.index}: cannot export recovery (${issue.reason})`,
            )
            .join('; '),
        );
      return recovery;
    });
  }

  reset(): void {
    if (this.busy) throw new MonoidCardError('Card sync is in progress');
    this.executions.clear();
    this.update({
      cards: [],
      phase: 'collect',
      progress: undefined,
      confirmedSnapshot: undefined,
    });
  }
}
