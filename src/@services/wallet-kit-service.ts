import type {IWalletKit, WalletKitTypes} from '@reown/walletkit';
import {PAIRING_EVENTS} from '@walletconnect/core';
import {getSdkError, parseUri} from '@walletconnect/utils';
import {observable, runInAction} from 'mobx';
import ms from 'ms';

import {parseWalletConnectUri} from '../@lib/wallet-connect.js';

const CONNECTION_REQUEST_TIMEOUT = ms('1m');

export class WalletKitService {
  readonly proposals = observable.map<number, WalletKitTypes.SessionProposal>(
    [],
    {deep: false},
  );

  private connecting = false;

  constructor(private kit: IWalletKit) {
    kit.on('proposal_expire', ({id}) => {
      runInAction(() => this.proposals.delete(id));
    });

    const onPairingEnded = ({topic}: {topic: string}): void => {
      runInAction(() => {
        for (const [id, proposal] of this.proposals) {
          if (proposal.params.pairingTopic === topic) this.proposals.delete(id);
        }
      });
    };

    kit.core.pairing.events.on(PAIRING_EVENTS.expire, onPairingEnded);
    kit.core.pairing.events.on(PAIRING_EVENTS.delete, onPairingEnded);
  }

  async reject(id: number): Promise<void> {
    const proposal = this.proposals.get(id);
    if (!proposal) return;

    runInAction(() => this.proposals.delete(id));

    if (proposal.params.expiryTimestamp * 1000 > Date.now()) {
      await this.kit.rejectSession({id, reason: getSdkError('USER_REJECTED')});
    }
  }

  async connect(
    value: string,
    signal: AbortSignal,
  ): Promise<WalletKitTypes.SessionProposal | undefined> {
    if (signal.aborted) return undefined;

    const uri = parseWalletConnectUri(value);

    if (!uri) {
      throw new Error('Invalid or expired WalletConnect QR code.');
    }

    if (this.connecting) {
      throw new Error('A connection request is already in progress.');
    }

    const {topic, expiryTimestamp} = parseUri(uri);
    const pairingEvents = this.kit.core.pairing.events;

    this.connecting = true;

    try {
      return await new Promise<WalletKitTypes.SessionProposal | undefined>(
        (resolve, reject) => {
          let settled = false;
          let paired = false;
          let pendingProposal: WalletKitTypes.SessionProposal | undefined;

          const dispose = (): boolean => {
            if (settled) return false;

            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            this.kit.off('session_proposal', onProposal);
            pairingEvents.off(PAIRING_EVENTS.expire, onPairingEnded);
            pairingEvents.off(PAIRING_EVENTS.delete, onPairingEnded);

            return true;
          };

          const fail = (error: unknown): void => {
            if (dispose()) reject(error);
          };

          const cancel = (): void => {
            if (dispose()) resolve(undefined);
          };

          const complete = (): void => {
            if (!paired || !pendingProposal) return;

            if (pendingProposal.params.expiryTimestamp * 1000 <= Date.now()) {
              fail(new Error('Connection request expired. Please scan again.'));
            } else if (dispose()) {
              runInAction(() => {
                this.proposals.set(pendingProposal!.id, pendingProposal!);
              });
              resolve(pendingProposal);
            }
          };

          const onProposal = (
            proposal: WalletKitTypes.SessionProposal,
          ): void => {
            if (proposal.params.pairingTopic !== topic) return;

            pendingProposal = proposal;
            complete();
          };

          const onPairingEnded = (event: {topic: string}): void => {
            if (event.topic === topic) {
              fail(new Error('Connection request ended. Please scan again.'));
            }
          };

          const timer = setTimeout(
            () => {
              fail(
                new Error('Connection request timed out. Please scan again.'),
              );
            },
            Math.min(
              CONNECTION_REQUEST_TIMEOUT,
              expiryTimestamp
                ? expiryTimestamp * 1000 - Date.now()
                : CONNECTION_REQUEST_TIMEOUT,
            ),
          );

          this.kit.on('session_proposal', onProposal);
          pairingEvents.on(PAIRING_EVENTS.expire, onPairingEnded);
          pairingEvents.on(PAIRING_EVENTS.delete, onPairingEnded);
          signal.addEventListener('abort', cancel, {once: true});

          // The SDK cannot abort pair(). Cancel only this wait; its temporary
          // pairing expires in the SDK, and any late rejection is still handled.
          void this.kit.pair({uri}).then(() => {
            paired = true;
            complete();
          }, fail);
        },
      );
    } finally {
      this.connecting = false;
    }
  }
}
