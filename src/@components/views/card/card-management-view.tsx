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
  APPLET_NAMES,
  type AppletStage,
  type MonoidAppletHello,
  MonoidCardError,
  MonoidWrongCardError,
  createMonoidApplet,
  getAppletCatalog,
  getAppletDependents,
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
import {AppletSelectionPopup} from './applet-selection-popup.js';

type Installation = Awaited<ReturnType<typeof readMonoidAppletInstallation>>;
type CardSnapshot = {
  information?: CardInformation;
  installation?: Installation;
  unsupported?: boolean;
};
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
      errorService,
    } = useEntrances();
    const [context] = useState(() => ({
      returnTo: view.returnTo,
      copyId: view.copyId,
      bundleId: view.bundleId,
      extensionId: view.extensionId,
    }));
    const [card, setCard] = useState<CardSnapshot>(() => ({
      information: view.cardInformation,
    }));
    const [complete, setComplete] = useState(false);
    const [busy, setBusy] = useState(false);
    const [popup, setPopup] = useState<
      'details' | 'menu' | 'install' | 'fresh' | AppletStage
    >();
    const [selectedOptional, setSelectedOptional] = useState<AppletStage[]>([]);
    const [confirm, setConfirm] = useState<{
      mode: CardMaintenanceMode;
      replaceStages?: AppletStage[];
      operationId?: string;
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
    const needsReplacement =
      pending && ['ready', 'replacing'].includes(pending.phase);
    const resumeLabel = needsReplacement
      ? pending.mode === 'fresh'
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
    ): Promise<CardSnapshot> {
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
      const fresh =
        action === 'fresh' ||
        (action === 'resume' && pending?.mode === 'fresh');
      let description: ReactNode =
        action === 'install' || fresh || action === 'setup' ? (
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
              fresh ||
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
      } = {},
    ): Promise<void> {
      if (!isActive() || controller.current || !hasAppletBundle) return;
      const operation = new AbortController();
      controller.current = operation;
      setBusy(true);
      setPopup(undefined);
      setConfirm(undefined);
      let pin: MonoidPIN | undefined;
      let accessPINId: MonoidIdHex | undefined;
      let appletsChanged = false;
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
            !saved.grants?.length &&
            (action === 'update' ||
              action === 'reinstall' ||
              action === 'install')
          ) {
            saved = undefined;
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
            (action === 'restore' &&
              (!saved ||
                !['restore', 'manual-restore'].includes(saved.phase))) ||
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
            appletsChanged = true;
          } else if (action === 'install') {
            next = await installMonoidApplets(
              sessionId,
              progress,
              signal,
              options.selectedOptionalStages,
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
          if (
            saved &&
            (maintenance.get(saved.id)?.phase === 'restore' ||
              (action === 'restore' &&
                saved.phase === 'manual-restore' &&
                saved.grants?.length))
          ) {
            setState('Authenticating, hold tight...');
            await applet.authenticate({secret: true, pin: pin!});
            signal.throwIfAborted();
            await maintenance.restore(applet, saved.id, progress, signal);
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
            errorService.catch(Promise.reject(error));
          }
        } else if (appletsChanged) {
          // Installation is recoverable by reading the card again; do not keep
          // the previous identity or a pending setup action after interruption.
          setCard({});
        }
        if (controller.current === operation) controller.current = undefined;
        setBusy(false);
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
    const back = backToCopy ?? backToBundle ?? backToSecurityKey ?? backToSafe;
    const backLabel = backToCopy
      ? 'Back to Copy'
      : backToBundle
        ? 'Back to Bundle'
        : backToSecurityKey
          ? 'Back to Security Key'
          : 'Back to Safe';
    const canStartMaintenance =
      !busy && (!pending || (manualRestore && !pending.grants?.length));
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
                  onClick={resumeMaintenance}
                >
                  {resumeLabel}
                </Button>
              ) : manualRestore && pending.grants?.length ? (
                <Button
                  color="warning"
                  disabled={busy}
                  onClick={resumeMaintenance}
                >
                  Restore applet access
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
        {(popup === 'install' || popup === 'fresh') && (
          <AppletSelectionPopup
            installation={installation}
            selected={selectedOptional}
            fresh={popup === 'fresh'}
            onChange={setSelectedOptional}
            onDismiss={() => setPopup(undefined)}
            onInstall={() => {
              if (popup === 'fresh') {
                setPopup(undefined);
                setConfirm({mode: 'fresh'});
              } else if (baseUpdateAvailable) {
                setPopup(undefined);
                setConfirm({
                  mode: 'update',
                  replaceStages: ['library', 'monoid'],
                });
              } else
                void perform('install', {
                  selectedOptionalStages: selectedOptional,
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
              })
            }
          >
            {confirm.mode === 'fresh' ? (
              <>
                <p>All items, PINs and bundle membership will be erased.</p>
                <p>The card will receive a new identity.</p>
              </>
            ) : replacesStorage && (hello?.bundle || pending?.card.bundle) ? (
              <>
                <p>Copy your items to another bundle card before continuing.</p>
                <p>Restore them from that card after installation.</p>
              </>
            ) : replacesStorage ? (
              <p>
                {confirm.operationId
                  ? 'Items and applet access will be restored after installation.'
                  : 'Items and applet access will be backed up and restored.'}
              </p>
            ) : (
              <p>Items and applet access will be preserved.</p>
            )}
            {affectsSecurityKey && (
              <p>
                {confirm.mode === 'fresh' &&
                !selectedOptional.includes('security-key')
                  ? 'Monoid Security Key Applet and its FIDO PIN will be removed.'
                  : 'Monoid Security Key Applet will be reinstalled. Its FIDO PIN will be reset.'}
              </p>
            )}
          </ConfirmPopup>
        )}
      </>
    );
  },
);
