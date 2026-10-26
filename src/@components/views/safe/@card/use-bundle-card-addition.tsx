import {reaction, runInAction} from 'mobx';
import {type ReactNode, useEffect, useRef, useState} from 'react';

import type {MonoidIdHex, MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  MonoidAppletHello,
  assertCardPINsNotBlocked,
  initializeMonoidCard,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {MonoidScanStatePromptContentHighlight} from '../../../@monoid/monoid-scan-prompt.js';
import {requestCardPINs} from '../../../@monoid/request-card-pins.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {ConfirmPopup} from '../../../@ui/confirm-popup.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';

import {
  type CardResetIdentity,
  CardResetSession,
} from './card-reset-session.js';
import type {CardSecretPINSession} from './card-secret-pin-session.js';
import {CardSetupPIN} from './card-setup-pin.js';
import {readCardForSetup} from './read-card-for-setup.js';

function hasInitializedPINs(hello: MonoidAppletHello): boolean {
  return !!hello.pins.secret && !!hello.pins.access;
}

export function useBundleCardAddition({
  isActive: isViewActive,
  validateAddition,
  onAdded,
  onNeedsInstall,
  secretPINSession,
  label = 'Add a card',
}: {
  isActive: () => boolean;
  validateAddition: (hello: MonoidAppletHello) => void;
  onAdded: (hello: MonoidAppletHello) => Promise<void>;
  onNeedsInstall: (information: CardInformation) => void;
  secretPINSession: CardSecretPINSession;
  label?: string;
}): {
  busy: boolean;
  addCard: () => Promise<void>;
  acceptCard: (hello: MonoidAppletHello) => Promise<boolean>;
  resume: () => Promise<void>;
  pendingPIN: MonoidAppletHello | undefined;
  pendingReset: CardResetSession | undefined;
  buttonLabel: string;
  content: ReactNode;
} {
  const {errorService, monoidApplet, cardStore, monoidCredentialsStore} =
    useEntrances();
  const scanPrompt = useIsoDepScanPrompt();
  const toast = useToast();
  const [pinInput, showPINInput] = useInputModal();
  const [pinSession] = useState(() =>
    monoidCredentialsStore.createPINSession(),
  );
  const [busy, setBusy] = useState(false);
  const [pendingPIN, setPendingPIN] = useState<MonoidAppletHello>();
  const [showPINSetup, setShowPINSetup] = useState(false);
  const [pendingReset, setPendingReset] = useState<CardResetSession>();
  const [pendingBundleCard, setPendingBundleCard] = useState<{
    card: CardResetIdentity;
    generation: number;
  }>();
  const bundleConfirmation = useRef(0);
  const cardOperation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cardOperation.current?.abort();
      pinSession.clear();
    };
  }, [pinSession]);

  useEffect(
    () =>
      reaction(isViewActive, active => {
        if (active) return;
        setShowPINSetup(false);
        bundleConfirmation.current++;
        setPendingBundleCard(undefined);
        cardOperation.current?.abort();
        pinSession.clear();
      }),
    [isViewActive, pinSession],
  );

  const isActive = (): boolean => mounted.current && isViewActive();

  const cacheSetup = (hello: MonoidAppletHello, emptyCard = false): void => {
    const identity = {
      id: uint8ArrayToHex(hello.id),
      publicKey: uint8ArrayToHex(hello.publicKey),
    };
    runInAction(() => {
      const cached =
        cardStore.get(identity) ??
        (emptyCard
          ? cardStore.set({
              ...identity,
              alias: hello.alias,
              allowPeerExtension: hello.allowPeerExtension,
              bundle:
                hello.bundle === false ? false : uint8ArrayToHex(hello.bundle),
              items: [],
            })
          : undefined);
      if (cached) {
        cached.requiresPINSetup =
          hello.pins.secret === false || hello.pins.access === false;
      }
    });
  };

  const completeSetup = async (hello: MonoidAppletHello): Promise<void> => {
    cacheSetup(hello);
    await onAdded(hello);
    if (mounted.current) {
      setPendingPIN(undefined);
      setPendingReset(undefined);
    }
  };

  const validateScan = (hello: MonoidAppletHello): void => {
    validateAddition(hello);
    // Reset does not need the old PINs, even when they are blocked.
    if (hello.bundle !== false) return;
    assertCardPINsNotBlocked(hello);
  };

  const acceptScan = async (hello: MonoidAppletHello): Promise<void> => {
    validateScan(hello);
    if (hello.bundle !== false) {
      setPendingBundleCard({
        card: {
          id: uint8ArrayToHex(hello.id),
          publicKey: uint8ArrayToHex(hello.publicKey),
          bundle: uint8ArrayToHex(hello.bundle),
        },
        generation: ++bundleConfirmation.current,
      });
    } else if (!hasInitializedPINs(hello)) {
      cacheSetup(hello);
      setPendingPIN(hello);
      setShowPINSetup(true);
    } else {
      await completeSetup(hello);
    }
  };

  const addCard = async (): Promise<void> => {
    if (
      cardOperation.current ||
      pendingBundleCard ||
      showPINSetup ||
      !isActive()
    )
      return;
    const operation = new AbortController();
    cardOperation.current = operation;
    setBusy(true);
    let completed: MonoidAppletHello | undefined;
    try {
      let result: Awaited<ReturnType<typeof readCardForSetup>> | undefined;
      await scanPrompt('Scan a card', async (sessionId, setState, signal) => {
        result = await readCardForSetup(
          sessionId,
          monoidApplet,
          setState,
          AbortSignal.any([signal, operation.signal]),
        );
        if (result.type === 'ready') {
          validateScan(result.hello);
          if (hasInitializedPINs(result.hello) && result.hello.bundle === false)
            completed = result.hello;
        }
      });
      if (!isActive() || operation.signal.aborted || !result) return;
      setPendingReset(undefined);
      setPendingPIN(undefined);
      if (result.type === 'setup') onNeedsInstall(result.cardInformation);
      else if (!completed) await acceptScan(result.hello);
    } catch (error) {
      if (!isOperationCancelled(error, operation.signal)) throw error;
    } finally {
      try {
        // Acknowledged reads survive navigation during native-sheet cleanup.
        if (completed) await completeSetup(completed);
      } finally {
        if (cardOperation.current === operation)
          cardOperation.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const resetAndAdd = async (reset: CardResetSession): Promise<void> => {
    if (cardOperation.current || !isActive()) return;
    const operation = new AbortController();
    const pinSignal = secretPINSession.signal;
    cardOperation.current = operation;
    setPendingReset(reset);
    setBusy(true);
    let pin: MonoidPIN | undefined;
    let accessPIN: MonoidPIN | undefined;
    let initialized: MonoidAppletHello | undefined;
    let completed: MonoidAppletHello | undefined;
    let accessPINId: MonoidIdHex | undefined;
    try {
      if (!reset.attempted) {
        await pinSession.authenticate(operation.signal);
        operation.signal.throwIfAborted();
        if (!isActive()) return;
        const requested = await requestCardPINs(
          showPINInput,
          {secretSet: false, accessSet: false},
          operation.signal,
        );
        if (!requested) return;
        pin = requested.secret;
        accessPIN = requested.access;
        operation.signal.throwIfAborted();
        if (!isActive()) return;
      }
      await scanPrompt(
        <>
          Scan card{' '}
          <MonoidScanStatePromptContentHighlight>
            {reset.replacement
              ? uint8ArrayToHex(reset.replacement.id)
              : reset.card.id}
          </MonoidScanStatePromptContentHighlight>
        </>,
        async (sessionId, setState, scanSignal) => {
          const signal = AbortSignal.any([
            scanSignal,
            operation.signal,
            pinSignal,
          ]);
          signal.throwIfAborted();
          const applet = await monoidApplet.openSession(sessionId);
          signal.throwIfAborted();
          const current = MonoidAppletHello.satisfies(await applet.hello({}));
          setState(
            reset.attempted
              ? 'Checking card, hold tight...'
              : 'Resetting card, hold tight...',
          );
          const cached = cardStore.get(reset.card);
          let hello = await reset.readOrReset(
            applet,
            current,
            () => pinSession.removePIN(reset.card.id, undefined, signal),
            () =>
              runInAction(() => {
                if (cached) {
                  cached.items = [];
                  cached.bundle = false;
                  cached.requiresPINSetup = true;
                }
              }),
            signal,
          );
          cacheSetup(
            hello,
            hello.pins.secret === false && hello.pins.access === false,
          );
          validateScan(hello);
          if (pin !== undefined) {
            signal.throwIfAborted();
            const rememberPIN = secretPINSession.onAuthenticated(
              readBackupCardIdentity(hello),
              pin,
            );
            setState('Setting Secret PIN, hold tight...');
            hello = await initializeMonoidCard(
              applet,
              hello,
              pin,
              signal,
              accessPIN,
            );
            rememberPIN();
            cacheSetup(hello);
            completed = hello;
            setState('Authenticating, hold tight...');
            await applet.authenticate({pin: accessPIN!});
            signal.throwIfAborted();
            accessPINId = uint8ArrayToHex(hello.id);
          }
          initialized = hello;
          if (hasInitializedPINs(hello)) completed = hello;
        },
      );
      if (accessPINId && pin && isActive() && !operation.signal.aborted) {
        try {
          await pinSession.setPIN(accessPINId, accessPIN!, operation.signal);
        } catch {
          toast({
            message: 'Access PIN was not saved on this device',
            color: 'warning',
          });
        }
      }
      if (!isActive() || operation.signal.aborted || !initialized) return;
      if (!completed) await acceptScan(initialized);
      setPendingReset(undefined);
    } catch (error) {
      if (!isOperationCancelled(error, operation.signal)) throw error;
    } finally {
      pin = undefined;
      accessPIN = undefined;
      pinSession.clear();
      try {
        if (completed) await completeSetup(completed);
      } finally {
        if (cardOperation.current === operation)
          cardOperation.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const resume = async (): Promise<void> => {
    if (!isActive()) return;
    if (pendingPIN) setShowPINSetup(true);
    else if (pendingReset?.replacement) await resetAndAdd(pendingReset);
    else await addCard();
  };

  const acceptCard = async (hello: MonoidAppletHello): Promise<boolean> => {
    if (
      cardOperation.current ||
      showPINSetup ||
      pendingBundleCard ||
      !isActive()
    )
      return false;
    await acceptScan(hello);
    return true;
  };

  return {
    busy: busy || showPINSetup || !!pendingBundleCard,
    addCard,
    acceptCard,
    resume,
    pendingPIN,
    pendingReset,
    buttonLabel: pendingPIN
      ? pendingPIN.pins.secret === false
        ? 'Set Secret PIN'
        : pendingPIN.pins.access === false
          ? 'Set Access PIN'
          : 'Continue'
      : pendingReset?.replacement
        ? 'Check card'
        : label,
    content: (
      <>
        {showPINSetup && pendingPIN && isActive() && (
          <CardSetupPIN
            hello={pendingPIN}
            pinSession={pinSession}
            secretPINSession={secretPINSession}
            onInitialized={hello => {
              errorService.catch(completeSetup(hello));
            }}
            onFinished={(initialized, current) => {
              if (!isActive()) return;
              setShowPINSetup(false);
              if (!initialized && current) setPendingPIN(current);
            }}
          />
        )}
        {pendingBundleCard && !busy && isActive() && (
          <ConfirmPopup
            key={pendingBundleCard.generation}
            title="Reset card and join bundle?"
            confirmColor="danger"
            confirmText={['I understand, add card', 'Confirm']}
            onCancel={() => {
              bundleConfirmation.current++;
              setPendingBundleCard(undefined);
            }}
            onConfirm={errorService.catch(async () => {
              if (
                !isActive() ||
                pendingBundleCard.generation !== bundleConfirmation.current
              )
                return;
              bundleConfirmation.current++;
              setPendingBundleCard(undefined);
              await resetAndAdd(new CardResetSession(pendingBundleCard.card));
            })}
          >
            <p>Card {pendingBundleCard.card.id} already belongs to a bundle.</p>
            <ol>
              <li>
                Adding this card will erase its stored items and both PINs, and
                change its Card ID.
              </li>
              <li>
                This card will no longer be able to receive data from other
                cards in its original bundle.
              </li>
            </ol>
          </ConfirmPopup>
        )}
        {isActive() && pinInput}
      </>
    ),
  };
}
