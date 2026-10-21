import {Ellipsis as ellipsis, Info as info} from 'lucide-react';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidIdHex, MonoidPIN, PublicKeyHex} from '../../../@atomics.js';
import {useEntrances} from '../../../@entrances.js';
import {
  type CardInformation,
  readCardInformation,
} from '../../../@lib/global-platform/card-information.js';
import {CardManagerNotFoundError} from '../../../@lib/global-platform/install.js';
import {getCardInstallationChecks} from '../../../@lib/global-platform/installation-support.js';
import {
  type MonoidAppletHello,
  MonoidCardError,
  MonoidWrongCardError,
  createMonoidApplet,
  hasAppletBundle,
  initializeMonoidCard,
  installMonoidApplets,
  readMonoidAppletInstallation,
  resolveMonoidAppletMaintenanceAid,
} from '../../../@lib/monoid/index.js';
import type {Router} from '../../../@routes.js';
import {
  type CardMaintenanceMode,
  type CardMaintenanceProgress,
  cardFingerprint,
  isCredentialRequestCancelled,
} from '../../../@services/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';
import {AppletInstallProgressContent} from '../../@monoid/applet-install-progress.js';
import {MonoidScanStatePromptProgress} from '../../@monoid/monoid-scan-prompt.js';
import {
  PINKind,
  getPINInputPlaceholder,
} from '../../@monoid/pin-input-placeholder.js';
import {useIsoDepScanPrompt} from '../../@monoid/use-isodep-scan-prompt.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {Button} from '../../@ui/button.js';
import {ConfirmPopup} from '../../@ui/confirm-popup.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
import {InfoMessage} from '../../@ui/message-content.js';
import {OperationComplete} from '../../@ui/operation-complete.js';
import {useToast} from '../../@ui/toast.js';
import {useInputModal} from '../../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  useViewActive,
} from '../../@view/index.js';
import {CardInformationPopup} from '../safe/index.js';

import {
  CardAppletsContent,
  CardInformationContent,
  CardScanPlaceholder,
} from './card-management-content.js';

type Installation = Awaited<ReturnType<typeof readMonoidAppletInstallation>>;
type CardSnapshot = {
  information?: CardInformation;
  installation?: Installation;
  unsupported?: boolean;
};
type Action = CardMaintenanceMode | 'install' | 'restore' | 'setup';

const HeaderActions = styled.div`
  grid-column: 3;
  align-self: center;
  display: flex;
  gap: 4px;

  > button:not(:last-child) {
    margin-right: 0;
  }
`;

function Progress({progress}: {progress: CardMaintenanceProgress}): ReactNode {
  if ('completed' in progress) {
    return (
      <MonoidScanStatePromptProgress
        current={progress.completed}
        total={progress.total}
      >
        {progress.stage === 'backup' ? 'Exporting items' : 'Restoring items'}
      </MonoidScanStatePromptProgress>
    );
  }
  if (progress.stage === 'deleting') return 'Removing applets, hold tight...';
  return <AppletInstallProgressContent update={progress} />;
}

export const CardManagementView = observer(
  ({view}: RouteComponentProps<Router['cardApplets']>): ReactNode => {
    const {
      router,
      monoidCredentialsStore,
      cardMaintenanceService: maintenance,
      copyItemsStore,
      cardBundleStore,
      cardStore,
      errorService,
    } = useEntrances();
    const [context] = useState(() => ({
      returnTo: view.returnTo,
      copyId: view.copyId,
      bundleId: view.bundleId,
    }));
    const [card, setCard] = useState<CardSnapshot>(() => ({
      information: view.cardInformation,
    }));
    const [complete, setComplete] = useState(false);
    const [busy, setBusy] = useState(false);
    const [popup, setPopup] = useState<'details' | 'menu'>();
    const [confirm, setConfirm] = useState<CardMaintenanceMode>();
    const [pinContent, showPIN] = useInputModal();
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const scan = useIsoDepScanPrompt();
    const toast = useToast();
    const isActive = useViewActive(view);
    const controller = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
      const dispose = reaction(isActive, active => {
        if (!active) {
          controller.current?.abort();
          pinSession.clear();
          setComplete(false);
          setPopup(undefined);
          setConfirm(undefined);
        }
      });
      return () => {
        dispose();
        controller.current?.abort();
        pinSession.clear();
      };
    }, [isActive, pinSession]);

    const installation = card.installation;
    const hello = installation?.hello;
    const pending = maintenance.matchOperation({
      hello,
      cardInformation: card.information,
    });
    const appletsPage =
      !!installation?.monoid.installed ||
      (installation?.identity.installed &&
        installation.monoid.installed !== false) ||
      !!pending ||
      card.unsupported;
    const initialized =
      hello && hello.pins.secret !== false && hello.pins.access !== false;
    const recovery = !!pending?.archive;
    const manualRestore = pending?.phase === 'manual-restore';
    const needsResume = pending && !manualRestore;

    async function readSnapshot(
      sessionId: string,
      signal: AbortSignal,
      information?: CardInformation,
    ): Promise<CardSnapshot> {
      const installation = await readMonoidAppletInstallation(
        sessionId,
        signal,
      );
      try {
        information ??= await readCardInformation(sessionId, signal);
      } catch (error) {
        if (error instanceof CardManagerNotFoundError) {
          return {
            installation,
            unsupported:
              !installation.identity.installed &&
              !installation.monoid.installed,
          };
        }
        throw error;
      }
      const checks = getCardInstallationChecks(information);
      return {
        information,
        installation,
        unsupported:
          !installation.identity.installed &&
          !installation.monoid.installed &&
          checks.length > 0 &&
          checks.every(check => !check.supported),
      };
    }

    async function scanCard(): Promise<void> {
      if (!isActive() || busy) return;
      setBusy(true);
      setComplete(false);
      try {
        await scan('Scan a card', async (sessionId, setState, signal) => {
          setState('Reading card, hold tight...');
          try {
            const snapshot = await readSnapshot(sessionId, signal);
            signal.throwIfAborted();
            setCard(snapshot);
          } catch (error) {
            if (error instanceof CardManagerNotFoundError) {
              setCard({unsupported: true});
              return;
            }
            throw error;
          }
        });
      } catch (error) {
        if (!isCredentialRequestCancelled(error)) {
          errorService.catch(Promise.reject(error));
        }
      } finally {
        setBusy(false);
      }
    }

    async function requestPIN(
      action: Action,
      signal: AbortSignal,
    ): Promise<MonoidPIN | undefined> {
      let description: ReactNode =
        action === 'install' || action === 'fresh' || action === 'setup' ? (
          <>
            Will be used as initial <PINKind kind="Access" /> PIN
          </>
        ) : undefined;

      for (;;) {
        const value = await showPIN(
          {
            type: 'password',
            ...getPINInputPlaceholder(
              'Secret',
              action === 'fresh' ||
                hello?.pins.secret === false ||
                (action === 'install' &&
                  installation?.identity.installed === false)
                ? 'Set'
                : 'Enter',
            ),
            description,
            maxLength: 16,
            center: true,
          },
          signal,
        );
        if (value === undefined || signal.aborted || !isActive()) return;
        if (MonoidPIN.is(value)) return value;
        description = 'Use 6 to 16 ASCII characters';
      }
    }

    async function finishSetup(
      result: MonoidAppletHello,
      snapshot: CardSnapshot,
    ): Promise<void> {
      const identity = {
        id: uint8ArrayToHex(result.id),
        publicKey: uint8ArrayToHex(result.publicKey),
      };
      runInAction(() => {
        const cached = cardStore.get(identity);
        if (cached) cached.requiresPINSetup = false;
      });
      if (context.returnTo === 'copy' && context.copyId) {
        await copyItemsStore.get(context.copyId)?.session.addTarget(result);
      }
      if (context.returnTo === 'bundle' && context.bundleId) {
        await cardBundleStore.acceptInstalledCard(context.bundleId, result);
      }
      setCard(snapshot);
      if (isActive()) setComplete(true);
    }

    async function perform(action: Action): Promise<void> {
      if (!isActive() || controller.current || !hasAppletBundle) return;
      const operation = new AbortController();
      controller.current = operation;
      setBusy(true);
      setPopup(undefined);
      setConfirm(undefined);
      let pin: MonoidPIN | undefined;
      let accessPINId: MonoidIdHex | undefined;
      let result:
        | {hello: MonoidAppletHello; snapshot: CardSnapshot}
        | undefined;

      try {
        pin = await requestPIN(action, operation.signal);
        if (!pin) return;
        await pinSession.authenticate(operation.signal);
        operation.signal.throwIfAborted();
        if (!isActive()) return;

        await scan('Scan the card', async (sessionId, setState, scanSignal) => {
          const signal = AbortSignal.any([operation.signal, scanSignal]);
          const progress = (progress: CardMaintenanceProgress): void =>
            setState(<Progress progress={progress} />);
          setState('Reading card, hold tight...');
          const information = await readCardInformation(sessionId, signal);
          if (
            card.information?.cplc &&
            cardFingerprint(information) !== cardFingerprint(card.information)
          ) {
            throw new MonoidCardError('Scan the same card');
          }
          const current = await readMonoidAppletInstallation(sessionId, signal);
          signal.throwIfAborted();
          let saved = maintenance.matchOperation({
            hello: current.hello,
            cardInformation: information,
          });

          if (
            pending &&
            !manualRestore &&
            action !== 'fresh' &&
            saved?.id !== pending.id
          ) {
            throw new MonoidCardError('Scan the same card');
          }
          if (!pending && hello) {
            if (
              !current.hello ||
              uint8ArrayToHex(current.hello.publicKey) !==
                uint8ArrayToHex(hello.publicKey)
            ) {
              throw new MonoidWrongCardError(uint8ArrayToHex(hello.id));
            }
          }
          if (
            saved?.phase === 'manual-restore' &&
            (action === 'update' || action === 'reinstall')
          ) {
            saved = undefined;
          }

          if (action === 'fresh') {
            saved = await maintenance.prepareFresh(
              information,
              current.hello,
              signal,
            );
          } else if (
            (action === 'update' || action === 'reinstall') &&
            !saved
          ) {
            if (!current.hello)
              throw new MonoidCardError('Could not read Monoid Applet');
            const appletAid = await resolveMonoidAppletMaintenanceAid(
              sessionId,
              current,
              signal,
            );
            const applet = await createMonoidApplet(
              hexToUint8Array(appletAid),
            ).openSession(sessionId);
            await applet.authenticate({secret: true, pin: pin!});
            signal.throwIfAborted();
            saved = await maintenance.prepare(applet, {
              mode: action,
              appletAid,
              cardInformation: information,
              onProgress: progress,
              signal,
            });
          }

          let next: MonoidAppletHello;
          if (saved) {
            if (
              saved.card.id &&
              saved.card.publicKey &&
              (saved.phase === 'ready' || saved.phase === 'replacing')
            ) {
              cardStore.forget({
                id: MonoidIdHex.satisfies(saved.card.id),
                publicKey: PublicKeyHex.satisfies(saved.card.publicKey),
              });
            }
            next = await maintenance.replace(
              sessionId,
              saved.id,
              progress,
              signal,
            );
          } else if (action === 'install') {
            next = await installMonoidApplets(sessionId, progress, signal);
            await maintenance.recordInstallation(next, {
              identity:
                current.identity.installed === false &&
                current.identity.loaded === false,
              monoid:
                current.monoid.installed === false &&
                current.monoid.loaded === false,
            });
          } else if (action === 'setup' && current.hello) {
            next = current.hello;
          } else {
            throw new MonoidCardError('Scan the card again');
          }

          signal.throwIfAborted();
          const applet = await createMonoidApplet(
            saved ? hexToUint8Array(saved.card.appletAid) : undefined,
          ).openSession(sessionId);
          if (next.pins.secret === 0) {
            throw new MonoidCardError('Secret PIN blocked');
          }
          if (next.pins.access === 0) {
            throw new MonoidCardError('Access PIN blocked');
          }
          if (next.pins.access === false || next.pins.secret === false) {
            setState('Setting up PINs...');
            const accessUnset = next.pins.access === false;
            next = await initializeMonoidCard(applet, next, pin!, signal);
            if (accessUnset) {
              await applet.authenticate({pin: pin!});
              signal.throwIfAborted();
              accessPINId = uint8ArrayToHex(next.id);
            }
          }
          if (saved && maintenance.get(saved.id)?.phase === 'restore') {
            setState('Authenticating, hold tight...');
            await applet.authenticate({secret: true, pin: pin!});
            signal.throwIfAborted();
            await maintenance.restore(applet, saved.id, progress, signal);
          }
          if (saved?.mode === 'fresh') await maintenance.complete(saved.id);

          if (action !== 'setup' || saved) setState('Reading card...');
          const latest =
            action === 'setup' && !saved
              ? {information, installation: {...current, hello: next}}
              : await readSnapshot(sessionId, signal, information);
          signal.throwIfAborted();
          // Show the verified result while the system sheet closes. Publish the
          // snapshot and hand off to other flows only after cleanup, so the
          // applet list never flashes beneath the closing scan overlay.
          result = {hello: next, snapshot: latest};
          if (isActive()) setComplete(true);
        });

        if (accessPINId) {
          try {
            await pinSession.setPIN(accessPINId, pin, operation.signal);
          } catch {
            toast({
              message: 'Access PIN was not saved on this device',
              color: 'warning',
            });
          }
        }
      } catch (error) {
        if (!operation.signal.aborted && !isCredentialRequestCancelled(error)) {
          errorService.catch(Promise.reject(error));
        }
      } finally {
        pin = undefined;
        pinSession.clear();
        // The scan overlay can close before another route takes focus. A card
        // already verified as complete must still reach its originating flow.
        if (result) {
          try {
            await finishSetup(result.hello, result.snapshot);
          } catch (error) {
            setComplete(false);
            errorService.catch(Promise.reject(error));
          }
        }
        if (controller.current === operation) controller.current = undefined;
        setBusy(false);
      }
    }

    function requestMaintenance(mode: CardMaintenanceMode): void {
      setPopup(undefined);
      if (mode === 'fresh' || hello?.bundle) setConfirm(mode);
      else void perform(mode);
    }

    const backToCopy =
      context.returnTo === 'copy'
        ? router.$backTo(router.safe.copyItems.$exact)
        : undefined;
    const backToBundle =
      context.returnTo === 'bundle'
        ? router.$backTo(router.safe.setupCard.$exact)
        : undefined;
    const backToSafe =
      context.returnTo === 'safe'
        ? router.$backTo(router.safe.$exact)
        : undefined;
    const back = backToCopy ?? backToBundle ?? backToSafe;
    const backLabel = backToCopy
      ? 'Back to Copy'
      : backToBundle
        ? 'Back to Bundle'
        : 'Back to Safe';
    const canMaintain =
      !busy &&
      (!pending || manualRestore) &&
      !!installation?.identity.installed;
    const canFreshInstall =
      !busy && !!card.information && !!installation?.identity.installed;
    const updateAvailable = hello && maintenance.isUpdateAvailable(hello);

    return (
      <>
        <View>
          <ViewHeader>
            <ViewHeaderTitle>
              {appletsPage ? 'Card applets' : 'Card information'}
            </ViewHeaderTitle>
            <HeaderActions>
              {card.information && (
                <ViewHeaderButton
                  aria-label="Card information"
                  disabled={busy}
                  onClick={() => setPopup('details')}
                >
                  <AppIcon icon={info} />
                </ViewHeaderButton>
              )}
              {appletsPage && !card.unsupported && !complete && (
                <ViewHeaderButton
                  aria-label="Card menu"
                  disabled={busy}
                  onClick={() => setPopup('menu')}
                >
                  <AppIcon icon={ellipsis} />
                </ViewHeaderButton>
              )}
            </HeaderActions>
          </ViewHeader>
          <ViewContent
            footer={
              complete ? (
                <Button
                  color="neutral"
                  disabled={busy}
                  onClick={() => {
                    if (back) back();
                    else setComplete(false);
                  }}
                >
                  {back ? backLabel : 'Back to Card Applets'}
                </Button>
              ) : needsResume ? (
                <Button
                  color={recovery ? 'warning' : 'primary'}
                  disabled={busy}
                  onClick={() => void perform('restore')}
                >
                  {recovery ? 'Restore items' : 'Continue'}
                </Button>
              ) : (!card.information && !installation) || card.unsupported ? (
                <Button
                  color={card.unsupported ? 'neutral' : 'primary'}
                  disabled={busy}
                  onClick={() => void scanCard()}
                >
                  {card.unsupported ? 'Scan another card' : 'Scan a card'}
                </Button>
              ) : !installation?.monoid.installed && card.information ? (
                <Button
                  disabled={busy || !hasAppletBundle}
                  onClick={() => void perform('install')}
                >
                  Install applets
                </Button>
              ) : hello && !initialized ? (
                <Button disabled={busy} onClick={() => void perform('setup')}>
                  Set Secret PIN
                </Button>
              ) : updateAvailable ? (
                <Button
                  disabled={busy}
                  onClick={() => requestMaintenance('update')}
                >
                  Update Monoid Applet
                </Button>
              ) : (
                <Button
                  color="neutral"
                  disabled={busy}
                  onClick={() => void scanCard()}
                >
                  {installation?.helloError || installation?.registryError
                    ? 'Scan again'
                    : 'Scan another card'}
                </Button>
              )
            }
          >
            {complete ? (
              <>
                <OperationComplete />
                {manualRestore && (
                  <InfoMessage>
                    Restore your items from another bundle card.
                  </InfoMessage>
                )}
              </>
            ) : card.unsupported || (!card.information && !installation) ? (
              <CardScanPlaceholder unsupported={card.unsupported} />
            ) : appletsPage ? (
              <CardAppletsContent
                id={hello ? uint8ArrayToHex(hello.id) : pending?.card.id}
                bundled={!!(hello?.bundle || pending?.card.bundle)}
                recovery={recovery}
                manualRestore={manualRestore}
                applets={(['identity', 'monoid'] as const).map(name => ({
                  name,
                  installed: installation?.[name].installed ?? false,
                  version: installation?.[name].version?.toString(),
                  unknown:
                    installation?.[name].installed === undefined ||
                    (name === 'monoid' && !!installation?.helloError),
                  update: name === 'monoid' && updateAvailable,
                }))}
              />
            ) : card.information ? (
              <CardInformationContent information={card.information} />
            ) : (
              <CardScanPlaceholder />
            )}
          </ViewContent>
        </View>
        {pinContent}
        {popup === 'details' && card.information && (
          <CardInformationPopup
            information={card.information}
            onDismiss={() => setPopup(undefined)}
          />
        )}
        {popup === 'menu' && (
          <DetailsPopup
            aria-label="Card applets"
            onDismiss={() => setPopup(undefined)}
          >
            <DetailsPopupTitle>Card applets</DetailsPopupTitle>
            <DetailsPopupDivider />
            {!updateAvailable && (
              <Button
                color="neutral"
                disabled={!canMaintain || !hello}
                onClick={() => requestMaintenance('reinstall')}
              >
                Reinstall Monoid Applet
              </Button>
            )}
            <Button
              color="danger"
              disabled={!canFreshInstall}
              onClick={() => requestMaintenance('fresh')}
            >
              Fresh install
            </Button>
          </DetailsPopup>
        )}
        {confirm && (
          <ConfirmPopup
            title={
              confirm === 'fresh' ? 'Fresh install' : 'Replace Monoid Applet'
            }
            confirmColor={confirm === 'fresh' ? 'danger' : 'warning'}
            confirmText={['Continue', 'Confirm']}
            onCancel={() => setConfirm(undefined)}
            onConfirm={() => void perform(confirm)}
          >
            {confirm === 'fresh' ? (
              <>
                <p>All items, PINs and bundle membership will be erased.</p>
                <p>The card will receive a new identity.</p>
              </>
            ) : (
              <>
                <p>Copy your items to another bundle card before continuing.</p>
                <p>Restore them from that card after installation.</p>
              </>
            )}
          </ConfirmPopup>
        )}
      </>
    );
  },
);
