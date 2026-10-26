import {Ellipsis as ellipsis, Info as info} from 'lucide-react';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidIdHex, type MonoidPIN, PublicKeyHex} from '../../../@atomics.js';
import {useEntrances} from '../../../@entrances.js';
import {
  type CardInformation,
  readCardInformation,
} from '../../../@lib/global-platform/card-information.js';
import {CardManagerNotFoundError} from '../../../@lib/global-platform/install.js';
import {getCardInstallationChecks} from '../../../@lib/global-platform/installation-support.js';
import {
  APPLET_NAMES,
  type AppletStage,
  type IdentityInstallationOptions,
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  MonoidWrongCardError,
  assertCardPINsNotBlocked,
  assertSameCard,
  createMonoidApplet,
  getAppletCatalog,
  getAppletDependents,
  hasAppletBundle,
  initializeMonoidCard,
  installMonoidApplets,
  readCardIdentity,
  readMonoidAppletInstallation,
  resolveMonoidAppletMaintenanceAid,
} from '../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../@lib/operation-cancelled.js';
import type {Router} from '../../../@routes.js';
import {
  type CardMaintenanceMode,
  type CardMaintenanceOperation,
  type CardMaintenanceProgress,
  type CardMaintenanceRestoreResult,
  cardFingerprint,
} from '../../../@services/index.js';
import {
  createFlowId,
  hexToUint8Array,
  uint8ArrayToHex,
} from '../../../@utils/index.js';
import {popOutAnimationCSS} from '../../@animations.js';
import {AppletInstallProgressContent} from '../../@monoid/applet-install-progress.js';
import {MonoidScanStatePromptProgress} from '../../@monoid/monoid-scan-prompt.js';
import {
  type CardSetupPINs,
  requestCardPINs,
} from '../../@monoid/request-card-pins.js';
import {useIsoDepScanPrompt} from '../../@monoid/use-isodep-scan-prompt.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {Button, Buttons} from '../../@ui/button.js';
import {ConfirmNotices, ConfirmPopup} from '../../@ui/confirm-popup.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../@ui/details-popup.js';
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
import {CardInformationPopup, SyncCardsState} from '../safe/index.js';

import {AppletSelectionPopup} from './applet-selection-popup.js';
import type {CardAppletSnapshot} from './card-applet-snapshot.js';
import {
  CardAppletsContent,
  CardInformationContent,
  CardMaintenanceCards,
  CardMaintenanceContent,
  CardScanPlaceholder,
} from './card-management-content.js';
type Action = CardMaintenanceMode | 'install' | 'resume' | 'restore' | 'setup';

const HeaderActions = styled.div`
  grid-column: 3;
  align-self: center;
  display: flex;
  gap: 4px;

  > button:not(:last-child) {
    margin-right: 0;
  }
`;

const MaintenanceProcess = styled.div<{$exiting: boolean}>`
  display: flex;
  flex-direction: column;
  gap: 8px;

  ${props => props.$exiting && popOutAnimationCSS}

  @media (prefers-reduced-motion: reduce) {
    animation-duration: 1ms;
  }
`;

function Progress({progress}: {progress: CardMaintenanceProgress}): ReactNode {
  if (progress.stage === 'deleting')
    return <AppletInstallProgressContent update={progress} />;
  if ('completed' in progress) {
    return (
      <MonoidScanStatePromptProgress
        current={progress.completed}
        total={progress.total}
      >
        {progress.stage === 'backup'
          ? 'Exporting items'
          : progress.stage === 'restoring-grants'
            ? 'Restoring applet access'
            : 'Restoring items'}
      </MonoidScanStatePromptProgress>
    );
  }
  if (
    progress.stage === 'verifying-backup' ||
    progress.stage === 'verifying-restore' ||
    progress.stage === 'verifying-grants'
  )
    return {
      'verifying-backup': 'Verifying backup, hold tight...',
      'verifying-restore': 'Verifying recovery, hold tight...',
      'verifying-grants': 'Verifying applet access, hold tight...',
    }[progress.stage];
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
      syncCardsStore,
      errorService,
    } = useEntrances();
    const [context] = useState(() => ({
      returnTo: view.returnTo,
      copyId: view.copyId,
      bundleId: view.bundleId,
      extensionId: view.extensionId,
    }));
    const [maintenanceSyncId] = useState(() => view.maintenanceSyncId);
    const [card, setCard] = useState<CardAppletSnapshot>(
      () =>
        (maintenanceSyncId
          ? syncCardsStore.get(maintenanceSyncId)?.maintenanceCardSnapshot
          : undefined) ?? {information: view.cardInformation},
    );
    const [complete, setComplete] = useState(false);
    const [operationSnapshot, setOperationSnapshot] =
      useState<CardMaintenanceOperation>();
    const [restoreReport, setRestoreReport] = useState<{
      operationId: string;
      operation: CardMaintenanceOperation;
      result: CardMaintenanceRestoreResult;
      canFinish: boolean;
    }>();
    const [busy, setBusy] = useState(false);
    const [popup, setPopup] = useState<
      | 'details'
      | 'menu'
      | 'install'
      | 'fresh'
      | 'restart'
      | 'finish'
      | AppletStage
    >();
    const [selectedOptional, setSelectedOptional] = useState<AppletStage[]>([]);
    const [confirm, setConfirm] = useState<{
      mode: CardMaintenanceMode;
      replaceStages?: AppletStage[];
      operationId?: string;
      identityOptions?: IdentityInstallationOptions;
    }>();
    const [pinContent, showPIN] = useInputModal();
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const scan = useIsoDepScanPrompt();
    const toast = useToast();
    const isActive = useViewActive(view);
    const controller = useRef<AbortController | undefined>(undefined);

    useEffect(() => {
      if (!maintenanceSyncId) return;
      // A cancelled back gesture may mount this view without returning to it.
      return reaction(
        isActive,
        active => {
          if (!active || view.maintenanceSyncId !== maintenanceSyncId) return;
          view.maintenanceSyncId = undefined;
          syncCardsStore.delete(maintenanceSyncId);
        },
        {fireImmediately: true},
      );
    }, [isActive, maintenanceSyncId, syncCardsStore, view]);

    useEffect(() => {
      const dispose = reaction(isActive, active => {
        if (!active) {
          controller.current?.abort();
          pinSession.clear();
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
    const [batchId, setBatchId] = useState<string>();
    const batch =
      (maintenance.batches ?? []).find(
        batch => batch.id === batchId || batch.id === pending?.batchId,
      ) ??
      (maintenance.batches ?? []).find(batch =>
        batch.targets.some(target => !target.complete),
      ) ??
      (maintenance.batches ?? []).at(-1);
    const batchComplete =
      !!batch && batch.targets.every(target => target.complete);
    const [stepsExited, setStepsExited] = useState(batchComplete);
    const processComplete =
      !busy && (batch ? batchComplete : complete && !pending);
    const appletsPage =
      !!batch ||
      !!installation?.monoid.installed ||
      (installation?.identity.installed &&
        installation.monoid.installed !== false) ||
      !!pending ||
      card.unsupported;
    const initialized =
      hello && hello.pins.secret !== false && hello.pins.access !== false;
    const recovery = !!pending?.archive;
    const reportedOperation =
      restoreReport &&
      (processComplete ||
        (!restoreReport.result.complete &&
          (restoreReport.result.issues.length ||
            restoreReport.result.droppedGrants.length)))
        ? restoreReport
        : undefined;
    const processOperation =
      reportedOperation?.operation ??
      (pending?.phase !== 'setup' ? pending : undefined) ??
      (busy || processComplete ? operationSnapshot : undefined);
    const needsReplacement =
      pending && ['ready', 'replacing'].includes(pending.phase);
    const canRestart =
      pending?.phase === 'ready' && pending.checkpoint === undefined;
    const resumeLabel = needsReplacement
      ? canRestart
        ? pending.mode === 'fresh'
          ? 'Fresh install'
          : pending.mode === 'update'
            ? 'Continue update'
            : 'Continue installation'
        : pending.mode === 'fresh'
          ? 'Resume fresh install'
          : pending.mode === 'update'
            ? 'Resume update'
            : 'Resume reinstall'
      : recovery
        ? 'Restore items'
        : 'Restore applet access';
    const optionalApplets = getAppletCatalog().filter(
      applet => applet.optional,
    );
    const installedOptional = optionalApplets
      .filter(applet => {
        const state = installation?.optional?.[applet.stage];
        return state?.installed || state?.loaded;
      })
      .map(applet => applet.stage);

    async function readSnapshot(
      sessionId: string,
      signal: AbortSignal,
      information?: CardInformation,
    ): Promise<CardAppletSnapshot> {
      const installation = await readMonoidAppletInstallation(
        sessionId,
        signal,
        {authenticateRegistry: true},
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

    function resetCompletion(): void {
      setComplete(false);
      setStepsExited(false);
      setOperationSnapshot(undefined);
      setRestoreReport(undefined);
    }

    async function scanCard(): Promise<void> {
      if (!isActive() || busy) return;
      setBusy(true);
      resetCompletion();
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
        if (!isOperationCancelled(error)) {
          errorService.catch(Promise.reject(error));
        }
      } finally {
        setBusy(false);
      }
    }

    async function finishSetup(
      result: MonoidAppletHello,
      snapshot: CardAppletSnapshot,
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
      if (context.returnTo === 'bundleExtension' && context.extensionId) {
        await cardBundleStore.acceptExtensionCard(context.extensionId, result);
      }
      setCard(snapshot);
      if (isActive()) setComplete(true);
    }

    async function perform(
      action: Action,
      options: {
        selectedOptionalStages?: readonly AppletStage[];
        replaceStages?: readonly AppletStage[];
        operationId?: string;
        identityOptions?: IdentityInstallationOptions;
        batchOperation?: CardMaintenanceOperation;
        finishWithout?: readonly string[];
      } = {},
    ): Promise<void> {
      if (!isActive() || controller.current || !hasAppletBundle) return;
      const pending =
        options.batchOperation ??
        maintenance.matchOperation({hello, cardInformation: card.information});
      const expectedHello = options.batchOperation ? undefined : hello;
      const operation = new AbortController();
      controller.current = operation;
      setBusy(true);
      setPopup(undefined);
      setConfirm(undefined);
      resetCompletion();
      let pin: MonoidPIN | undefined;
      let requestedPINs: CardSetupPINs | undefined;
      let accessPINId: MonoidIdHex | undefined;
      let appletsChanged = false;
      let syncId: string | undefined;
      let restoration: typeof restoreReport;
      let result:
        | {hello: MonoidAppletHello; snapshot: CardAppletSnapshot}
        | undefined;

      try {
        const savedPINs = await pinSession.getPINs(operation.signal);
        operation.signal.throwIfAborted();
        if (!isActive()) return;
        const fresh =
          action === 'fresh' ||
          (action === 'resume' && pending?.mode === 'fresh');
        const freshAlreadyInstalled =
          fresh &&
          action === 'resume' &&
          ['install', 'verify'].includes(pending?.checkpoint ?? '') &&
          !!hello &&
          uint8ArrayToHex(hello.publicKey) !== pending?.card.publicKey;
        const secretSet = options.batchOperation
          ? true
          : fresh
            ? freshAlreadyInstalled && hello!.pins.secret !== false
            : hello
              ? hello.pins.secret !== false
              : installation?.identity.installed === true ||
                !!pending?.card.publicKey;
        const stages = options.replaceStages ??
          pending?.replaceStages ?? ['library', 'monoid'];
        const collectingBundle =
          !!hello?.bundle &&
          !pending?.archive &&
          ['update', 'reinstall'].includes(action);
        const replacingMonoid =
          !collectingBundle &&
          !['install', 'verify'].includes(pending?.checkpoint ?? '') &&
          ['update', 'reinstall', 'resume'].includes(action) &&
          (stages.includes('monoid') || stages.includes('library'));
        const accessSet = fresh
          ? freshAlreadyInstalled && hello!.pins.access !== false
          : !replacingMonoid &&
            expectedHello?.pins.access !== false &&
            !!expectedHello;
        const id = expectedHello
          ? uint8ArrayToHex(expectedHello.id)
          : pending?.card.id;
        requestedPINs = await requestCardPINs(
          showPIN,
          {
            secretSet,
            accessSet,
            savedAccessPIN:
              !fresh && id ? savedPINs[MonoidIdHex.satisfies(id)] : undefined,
          },
          operation.signal,
        );
        if (!requestedPINs || !isActive()) return;
        pin = requestedPINs.secret;
        operation.signal.throwIfAborted();

        await scan('Scan the card', async (sessionId, setState, scanSignal) => {
          const signal = AbortSignal.any([operation.signal, scanSignal]);
          const progress = (progress: CardMaintenanceProgress): void =>
            setState(<Progress progress={progress} />);
          const setupPINs = async (
            applet: MonoidApplet,
            next: MonoidAppletHello,
          ): Promise<MonoidAppletHello> => {
            assertCardPINsNotBlocked(next);
            if (next.pins.access !== false && next.pins.secret !== false)
              return next;
            setState('Setting up PINs...');
            const accessUnset = next.pins.access === false;
            const initialized = await initializeMonoidCard(
              applet,
              next,
              pin!,
              signal,
              requestedPINs?.access,
            );
            if (accessUnset) {
              await applet.authenticate({pin: requestedPINs!.access!});
              signal.throwIfAborted();
              accessPINId = uint8ArrayToHex(initialized.id);
            }
            return initialized;
          };
          setState('Reading card, hold tight...');
          const information = await readCardInformation(sessionId, signal);
          if (
            !options.batchOperation &&
            card.information?.cplc &&
            cardFingerprint(information) !== cardFingerprint(card.information)
          ) {
            throw new MonoidCardError('Scan the same card');
          }
          const current = await readMonoidAppletInstallation(
            sessionId,
            signal,
            {authenticateRegistry: true},
          );
          signal.throwIfAborted();
          let saved = maintenance.matchOperation({
            hello: current.hello,
            cardInformation: information,
          });

          if (pending && action !== 'fresh' && saved?.id !== pending.id) {
            throw new MonoidCardError('Scan the same card');
          }
          if (!pending && hello) {
            if (!current.hello) {
              throw new MonoidWrongCardError(uint8ArrayToHex(hello.id));
            }
            assertSameCard(current.hello, readCardIdentity(hello));
          }
          // A newly chosen action must never inherit an earlier destructive
          // operation. Resuming binds the user's confirmation to its saved plan.
          if (options.operationId && saved?.id !== options.operationId) {
            throw new MonoidCardError('Scan the card again');
          }
          if (
            (action === 'resume' &&
              (!options.operationId ||
                !saved ||
                !['ready', 'replacing'].includes(saved.phase))) ||
            (action === 'restore' && saved?.phase !== 'restore') ||
            (action === 'setup' && saved) ||
            (action === 'fresh' && saved?.mode === 'fresh') ||
            (saved &&
              (action === 'install' ||
                action === 'update' ||
                action === 'reinstall'))
          ) {
            throw new MonoidCardError('Resume card maintenance first');
          }

          if (action === 'fresh') {
            saved = await maintenance.prepareFresh(
              information,
              current.hello,
              signal,
              options.selectedOptionalStages,
              options.identityOptions,
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
              selectedOptionalStages: options.selectedOptionalStages,
              replaceStages: options.replaceStages,
              appletAid,
              cardInformation: information,
              onProgress: progress,
              signal,
            });
          }

          // Bundle envelopes cannot be restored to their own sender. Sync to
          // a peer and save that peer's new exports before replacing storage.
          if (
            saved?.card.bundle &&
            !saved.archive &&
            saved.phase === 'ready' &&
            !maintenance.get(saved.id)
          ) {
            if (!current.hello)
              throw new MonoidCardError('Could not read Monoid Applet');
            const applet = await createMonoidApplet(
              hexToUint8Array(saved.card.appletAid),
            ).openSession(sessionId);
            const next = await setupPINs(applet, current.hello);
            const flow = new SyncCardsState(undefined, saved, {
              information,
              installation: {...current, hello: next},
            });
            await flow.session.add(applet, next, signal, pin, update =>
              setState(
                <MonoidScanStatePromptProgress
                  current={update.current}
                  total={update.total}
                >
                  {update.stage === 'exporting'
                    ? 'Exporting items'
                    : 'Reading items'}
                </MonoidScanStatePromptProgress>,
              ),
            );
            signal.throwIfAborted();
            syncId = createFlowId();
            syncCardsStore.getOrCreate(syncId, () => flow);
            return;
          }

          // Retain the process while successful card writes remove its saved task.
          setOperationSnapshot(saved);
          let next: MonoidAppletHello;
          if (saved) {
            const replacing =
              saved.phase === 'ready' || saved.phase === 'replacing';
            if (saved.card.id && saved.card.publicKey && replacing) {
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
            appletsChanged = replacing;
            if (saved.mode === 'fresh' && saved.card.id) {
              await pinSession.removePIN(
                MonoidIdHex.satisfies(saved.card.id),
                undefined,
                signal,
              );
            }
          } else if (action === 'install') {
            next = await installMonoidApplets(
              sessionId,
              progress,
              signal,
              options.selectedOptionalStages,
              options.identityOptions,
            );
            appletsChanged = true;
            await maintenance.recordInstallation(next, {
              identity:
                current.identity.installed === false &&
                current.identity.loaded === false,
              library: current.library.loaded === false,
              monoid:
                current.monoid.installed === false &&
                current.monoid.loaded === false,
              optional: (options.selectedOptionalStages ?? []).filter(
                stage => current.optional?.[stage]?.loaded === false,
              ),
            });
          } else if (action === 'setup' && current.hello) {
            next = current.hello;
          } else {
            throw new MonoidCardError('Scan the card again');
          }

          signal.throwIfAborted();
          const applet = cardStore.observeApplet(
            await createMonoidApplet(
              saved ? hexToUint8Array(saved.card.appletAid) : undefined,
            ).openSession(sessionId),
            next,
          );
          next = await setupPINs(applet, next);
          if (saved && maintenance.get(saved.id)?.phase === 'restore') {
            let installedAppletAids: string[] | undefined;
            if (saved.grants?.length) {
              const installed = await readMonoidAppletInstallation(
                sessionId,
                signal,
                {
                  authenticateRegistry: true,
                },
              );
              if (installed.registryError) throw installed.registryError;
              installedAppletAids = [
                installed.identity,
                installed.monoid,
                ...Object.values(installed.optional),
              ].flatMap(applet =>
                applet?.installed && applet.aid ? [applet.aid] : [],
              );
            }
            setState('Authenticating, hold tight...');
            await applet.authenticate({secret: true, pin: pin!});
            signal.throwIfAborted();
            const restored = await maintenance.restore(
              applet,
              saved.id,
              progress,
              signal,
              installedAppletAids,
              options.finishWithout,
            );
            restoration = {
              operationId: saved.id,
              operation: saved,
              result: restored,
              canFinish: !!maintenance.get(saved.id)?.rejectedItems?.length,
            };
          }
          if (action !== 'setup' || saved) setState('Reading card...');
          const latest =
            action === 'setup' && !saved
              ? {information, installation: {...current, hello: next}}
              : await readSnapshot(sessionId, signal, information);
          signal.throwIfAborted();
          // Publish the snapshot with completion after the scan and handoff,
          // so the applet list never flashes beneath the closing scan overlay.
          result = {hello: next, snapshot: latest};
        });

        if (accessPINId) {
          try {
            await pinSession.setPIN(
              accessPINId,
              requestedPINs!.access!,
              operation.signal,
            );
          } catch {
            toast({
              message: 'Access PIN was not saved on this device',
              color: 'warning',
            });
          }
        }
      } catch (error) {
        if (!isOperationCancelled(error, operation.signal)) {
          errorService.catch(Promise.reject(error));
        }
      } finally {
        pin = undefined;
        requestedPINs = undefined;
        pinSession.clear();
        // The scan overlay can close before another route takes focus. A card
        // already verified as complete must still reach its originating flow.
        if (result) {
          try {
            setRestoreReport(restoration);
            if (restoration && !restoration.result.complete) {
              setCard(result.snapshot);
            } else {
              await finishSetup(result.hello, result.snapshot);
              if (pending?.batchId) {
                setBatchId(pending.batchId);
                setComplete(false);
              }
            }
          } catch (error) {
            errorService.catch(Promise.reject(error));
          }
        } else {
          setOperationSnapshot(undefined);
          if (appletsChanged) {
            // Installation is recoverable by reading the card again; do not keep
            // the previous identity or a pending setup action after interruption.
            setCard({});
          }
        }
        if (controller.current === operation) controller.current = undefined;
        setBusy(false);
        if (syncId && isActive() && !operation.signal.aborted) {
          runInAction(() => {
            view.maintenanceSyncId = syncId;
          });
          router.safe.syncCards({syncId}).$push();
        }
      }
    }

    function requestMaintenance(
      mode: CardMaintenanceMode,
      replaceStages?: AppletStage[],
    ): void {
      setPopup(undefined);
      setSelectedOptional(installedOptional);
      setConfirm({
        mode,
        replaceStages:
          replaceStages && baseUpdateAvailable
            ? [...new Set<AppletStage>(['library', 'monoid', ...replaceStages])]
            : replaceStages,
      });
    }

    function requestInstall(fresh = false): void {
      setSelectedOptional(installedOptional);
      setPopup(fresh ? 'fresh' : 'install');
    }

    function resumeMaintenance(): void {
      if (!pending) return;
      if (needsReplacement) {
        setSelectedOptional([...(pending.selectedOptionalStages ?? [])]);
        setConfirm({
          mode: pending.mode,
          replaceStages: pending.replaceStages,
          operationId: pending.id,
        });
      } else {
        void perform('restore', {
          operationId: pending.id,
        });
      }
    }

    function resumeBatch(): void {
      const target = batch?.targets.find(target => !target.complete);
      if (!target) return;
      const operation = maintenance.get(target.operationId)!;
      setBatchId(batch!.id);
      if (operation.phase === 'ready' || operation.phase === 'replacing') {
        setSelectedOptional([...(operation.selectedOptionalStages ?? [])]);
        setConfirm({
          mode: operation.mode,
          replaceStages: operation.replaceStages,
          operationId: operation.id,
        });
      } else
        void perform('restore', {
          operationId: operation.id,
          batchOperation: operation,
        });
    }

    async function startOver(): Promise<void> {
      if (!isActive() || busy || !canRestart || !pending) return;
      setBusy(true);
      setPopup(undefined);
      try {
        await maintenance.discardPrepared(pending.id);
      } catch (error) {
        errorService.catch(Promise.reject(error));
      } finally {
        setBusy(false);
      }
    }

    const backToCopy =
      context.returnTo === 'copy'
        ? router.$backTo(router.safe.copyItems.$exact)
        : undefined;
    const backToBundle =
      context.returnTo === 'bundle'
        ? router.$backTo(router.safe.setupCard.$exact)
        : context.returnTo === 'bundleExtension'
          ? router.$backTo(router.safe.extendBundle.$exact)
          : undefined;
    const backToSafe =
      context.returnTo === 'safe'
        ? router.$backTo(router.safe.$exact)
        : undefined;
    const backToSecurityKey =
      context.returnTo === 'securityKey'
        ? router.$backTo(router.securityKey.$exact)
        : undefined;
    const backToOTP =
      context.returnTo === 'otp'
        ? router.$backTo(router.otp.$exact)
        : undefined;
    const back =
      backToCopy ??
      backToBundle ??
      backToSecurityKey ??
      backToOTP ??
      backToSafe;
    const backLabel = backToCopy
      ? 'Back to Copy'
      : backToBundle
        ? 'Back to Bundle'
        : backToSecurityKey
          ? 'Back to Security Key'
          : backToOTP
            ? 'Back to OTP'
            : 'Back to Safe';
    const canStartMaintenance = !busy && !pending;
    const canMaintain =
      canStartMaintenance && !!installation?.identity.installed;
    const canFreshInstall =
      !busy &&
      pending?.mode !== 'fresh' &&
      !!card.information &&
      !!installation?.identity.installed;
    const baseUpdateAvailable = hello && maintenance.isUpdateAvailable(hello);
    const optionalUpdates = hello
      ? installedOptional.filter(stage =>
          maintenance.isAppletUpdateAvailable(hello, stage),
        )
      : [];
    const updateAvailable = baseUpdateAvailable || optionalUpdates.length > 0;
    const updateStages: AppletStage[] = baseUpdateAvailable
      ? ['library', 'monoid']
      : optionalUpdates;
    const affectedStages = confirm
      ? [
          ...(confirm.mode === 'fresh'
            ? (['identity', 'library', 'monoid'] as const)
            : (confirm.replaceStages ?? (['library', 'monoid'] as const))),
          ...getAppletDependents(
            confirm.mode === 'fresh'
              ? ['identity', 'library', 'monoid']
              : (confirm.replaceStages ?? ['library', 'monoid']),
          ).map(applet => applet.stage),
        ]
      : [];
    const affectsSecurityKey =
      affectedStages.includes('security-key') &&
      (installedOptional.includes('security-key') ||
        (!!confirm?.operationId && selectedOptional.includes('security-key')));
    const replacesStorage = affectedStages.includes('monoid');
    const affectsOTP =
      affectedStages.includes('otp') && installedOptional.includes('otp');
    const confirmationOperation = confirm?.operationId
      ? maintenance.get(confirm.operationId)
      : pending;

    return (
      <>
        <View>
          <ViewHeader>
            <ViewHeaderTitle>Card applets</ViewHeaderTitle>
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
              {appletsPage && !batch && !card.unsupported && !complete && (
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
              restoreReport?.canFinish && !restoreReport.result.complete ? (
                // A card rejection repeats on retry, so finishing leads.
                <Buttons>
                  <Button
                    color="warning"
                    disabled={busy}
                    onClick={() => setPopup('finish')}
                  >
                    {`Finish without ${restoreReport.result.issues.length} items`}
                  </Button>
                  <Button
                    color="neutral"
                    disabled={busy}
                    onClick={batch ? resumeBatch : resumeMaintenance}
                  >
                    Retry
                  </Button>
                </Buttons>
              ) : batch ? (
                <Button
                  color={batchComplete ? 'neutral' : 'primary'}
                  disabled={busy}
                  onClick={() => {
                    if (batchComplete)
                      void maintenance
                        .dismissBatch(batch.id)
                        .then(() => {
                          setBatchId(undefined);
                          resetCompletion();
                        })
                        .catch(error =>
                          errorService.catch(Promise.reject(error)),
                        );
                    else resumeBatch();
                  }}
                >
                  {batchComplete
                    ? 'Back to Card Applets'
                    : `Continue card ${batch.targets.find(target => !target.complete)?.card.id}`}
                </Button>
              ) : complete ? (
                <Button
                  color="neutral"
                  onClick={() => {
                    if (back) back();
                    else resetCompletion();
                  }}
                >
                  {back ? backLabel : 'Back to Card Applets'}
                </Button>
              ) : pending ? (
                <Button
                  color={recovery ? 'warning' : 'primary'}
                  disabled={busy}
                  onClick={resumeMaintenance}
                >
                  {resumeLabel}
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
                  onClick={() => requestInstall()}
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
                  onClick={() => requestMaintenance('update', updateStages)}
                >
                  Update applets
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
            {processComplete &&
            (stepsExited || (!batch && !processOperation)) ? (
              <OperationComplete />
            ) : batch || processOperation ? (
              <MaintenanceProcess
                $exiting={processComplete}
                onAnimationEnd={event => {
                  if (processComplete && event.target === event.currentTarget) {
                    setStepsExited(true);
                    setOperationSnapshot(undefined);
                    setRestoreReport(undefined);
                  }
                }}
              >
                {batch && (
                  <CardMaintenanceCards
                    disabled={busy}
                    cards={batch.targets.map(target => {
                      const operation = maintenance.get(target.operationId);
                      return {
                        publicKey: target.card.publicKey!,
                        id: target.card.id,
                        complete: target.complete,
                        status: target.complete
                          ? 'complete'
                          : operation?.phase === 'restore'
                            ? 'restore items'
                            : operation?.phase === 'replacing'
                              ? 'resume installation'
                              : 'scan to install',
                      };
                    })}
                  />
                )}
                {processOperation && (
                  <CardMaintenanceContent
                    operation={processOperation}
                    processing={busy}
                    complete={processComplete}
                    report={reportedOperation?.result}
                  />
                )}
              </MaintenanceProcess>
            ) : complete ? null : card.unsupported ||
              (!card.information && !installation) ? (
              <CardScanPlaceholder unsupported={card.unsupported} />
            ) : appletsPage ? (
              <CardAppletsContent
                id={hello ? uint8ArrayToHex(hello.id) : pending?.card.id}
                bundled={!!(hello?.bundle || pending?.card.bundle)}
                recovery={recovery}
                applets={[
                  ...(['identity', 'monoid'] as const).map(name => ({
                    name,
                    installed: installation?.[name].installed ?? false,
                    version: installation?.[name].version?.toString(),
                    unknown:
                      installation?.[name].installed === undefined ||
                      (name === 'monoid' && !!installation?.helloError),
                    update: name === 'monoid' && baseUpdateAvailable,
                  })),
                  ...optionalApplets
                    .filter(
                      applet =>
                        installation?.optional?.[applet.stage]?.installed ||
                        installation?.optional?.[applet.stage]?.loaded,
                    )
                    .map(applet => ({
                      name: applet.stage,
                      selectable: true,
                      installed:
                        installation?.optional?.[applet.stage]?.installed ===
                        true,
                      unknown:
                        installation?.optional?.[applet.stage]?.installed !==
                        true,
                      update: optionalUpdates.includes(applet.stage),
                    })),
                ]}
                onSelectApplet={stage => {
                  if (optionalApplets.some(applet => applet.stage === stage))
                    setPopup(stage);
                }}
              />
            ) : card.information ? (
              <CardInformationContent information={card.information} />
            ) : (
              <CardScanPlaceholder />
            )}
          </ViewContent>
        </View>
        {pinContent}
        {popup === 'finish' && restoreReport && (
          <ConfirmPopup
            title={`Finish without ${restoreReport.result.issues.length} items?`}
            confirmText={`Finish without ${restoreReport.result.issues.length} items`}
            confirmColor="warning"
            onCancel={() => setPopup(undefined)}
            onConfirm={() =>
              void perform('restore', {
                operationId: restoreReport.operationId,
                batchOperation: batch
                  ? maintenance.get(restoreReport.operationId)
                  : undefined,
                finishWithout: restoreReport.result.issues.map(
                  issue => issue.index,
                ),
              })
            }
          >
            <ConfirmNotices
              notices={[
                'The skipped items will not be restored.',
                'Applet access that requires them will not be restored.',
                'The recovery archive will be discarded after verification.',
              ]}
            />
          </ConfirmPopup>
        )}
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
            {canRestart && (
              <Button
                color="neutral"
                disabled={busy}
                onClick={() => setPopup('restart')}
              >
                Start over
              </Button>
            )}
            {optionalApplets.some(
              applet => !installation?.optional?.[applet.stage]?.installed,
            ) && (
              <Button
                color="primary"
                disabled={!canStartMaintenance || !hasAppletBundle}
                onClick={() => requestInstall()}
              >
                Install applets
              </Button>
            )}
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
              onClick={() => requestInstall(true)}
            >
              Fresh install
            </Button>
          </DetailsPopup>
        )}
        {popup === 'restart' && (
          <ConfirmPopup
            title="Start over?"
            confirmText="Start over"
            onCancel={() => setPopup(undefined)}
            onConfirm={() => void startOver()}
          >
            Discard this preparation. Changes already written to cards will
            remain.
          </ConfirmPopup>
        )}
        {(popup === 'install' || popup === 'fresh') && (
          <AppletSelectionPopup
            installation={installation}
            selected={selectedOptional}
            fresh={popup === 'fresh'}
            onChange={setSelectedOptional}
            onDismiss={() => setPopup(undefined)}
            onInstall={(identityOptions = {}) => {
              if (popup === 'fresh') {
                setPopup(undefined);
                setConfirm({mode: 'fresh', identityOptions});
              } else if (baseUpdateAvailable) {
                setPopup(undefined);
                setConfirm({
                  mode: 'update',
                  replaceStages: ['library', 'monoid'],
                });
              } else
                void perform('install', {
                  selectedOptionalStages: selectedOptional,
                  identityOptions,
                });
            }}
          />
        )}
        {optionalApplets.some(applet => applet.stage === popup) && (
          <DetailsPopup
            aria-label={APPLET_NAMES[popup as AppletStage]}
            onDismiss={() => setPopup(undefined)}
          >
            <DetailsPopupTitle>
              {APPLET_NAMES[popup as AppletStage]}
            </DetailsPopupTitle>
            <DetailsPopupDivider />
            {popup === 'security-key' && hello && (
              <Button
                onClick={() => {
                  setPopup(undefined);
                  router
                    .securityKey({
                      card: {
                        id: uint8ArrayToHex(hello.id),
                        publicKey: uint8ArrayToHex(hello.publicKey),
                      },
                    })
                    .$push();
                }}
              >
                Open Security Key
              </Button>
            )}
            {popup === 'otp' && hello && (
              <Button
                onClick={() => {
                  setPopup(undefined);
                  router
                    .otp({
                      card: {
                        id: uint8ArrayToHex(hello.id),
                        publicKey: uint8ArrayToHex(hello.publicKey),
                      },
                    })
                    .$push();
                }}
              >
                Open OTP
              </Button>
            )}
            <Button
              color="neutral"
              disabled={!canMaintain || !hello}
              onClick={() =>
                requestMaintenance(
                  optionalUpdates.includes(popup as AppletStage)
                    ? 'update'
                    : 'reinstall',
                  [popup as AppletStage],
                )
              }
            >
              {optionalUpdates.includes(popup as AppletStage)
                ? 'Update applet'
                : 'Reinstall applet'}
            </Button>
          </DetailsPopup>
        )}
        {confirm && (
          <ConfirmPopup
            title={
              confirm.mode === 'fresh'
                ? 'Fresh install'
                : confirm.mode === 'update'
                  ? 'Update applets'
                  : 'Reinstall applets'
            }
            confirmColor={confirm.mode === 'fresh' ? 'danger' : 'warning'}
            confirmText={['Continue', 'Confirm']}
            onCancel={() => setConfirm(undefined)}
            onConfirm={() =>
              void perform(confirm.operationId ? 'resume' : confirm.mode, {
                selectedOptionalStages: selectedOptional,
                replaceStages: confirm.replaceStages,
                operationId: confirm.operationId,
                batchOperation:
                  batch && confirm.operationId
                    ? maintenance.get(confirm.operationId)
                    : undefined,
                identityOptions: confirm.identityOptions,
              })
            }
          >
            <ConfirmNotices
              notices={[
                ...(confirm.mode === 'fresh'
                  ? [
                      'All items, PINs and bundle membership will be erased.',
                      'Card keys will be regenerated.',
                      !!(hello || pending?.card.id) && 'Card ID will be kept.',
                    ]
                  : replacesStorage &&
                      (hello?.bundle || confirmationOperation?.card.bundle)
                    ? [
                        !confirmationOperation?.archive &&
                          'Sync items with another bundle card first.',
                        'Items and applet access will be restored after installation.',
                      ]
                    : [
                        replacesStorage
                          ? confirm.operationId
                            ? 'Items and applet access will be restored after installation.'
                            : 'Items and applet access will be backed up and restored.'
                          : 'Items and applet access will be preserved.',
                      ]),
                affectsSecurityKey &&
                  (confirm.mode === 'fresh' &&
                  !selectedOptional.includes('security-key')
                    ? 'Monoid Security Key Applet and its FIDO PIN will be removed.'
                    : 'Monoid Security Key Applet will be reinstalled. Its FIDO PIN will be reset. Set it again from a FIDO client.'),
                affectsOTP &&
                  (confirm.mode === 'fresh'
                    ? 'OTP accounts and access will be removed.'
                    : 'Monoid OTP Applet and its access will be restored.'),
              ]}
            />
          </ConfirmPopup>
        )}
      </>
    );
  },
);
