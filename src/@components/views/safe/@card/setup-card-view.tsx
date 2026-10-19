import {Info as info} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import {
  type CardInformation,
  readCardInformation,
} from '../../../../@lib/global-platform/card-information.js';
import {
  type MonoidAppletHello,
  MonoidCardError,
  hasAppletBundle,
  installMonoidApplets,
} from '../../../../@lib/monoid/index.js';
import type {Router} from '../../../../@routes.js';
import {isCredentialRequestCancelled} from '../../../../@services/index.js';
import {AppletInstallProgressContent} from '../../../@monoid/applet-install-progress.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {Button} from '../../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
import {InfoSectionItemLabel} from '../../../@ui/info-section.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  useViewActive,
} from '../../../@view/index.js';

import {CardInformationDetails} from './card-information-details.js';
import {CardSetupInformation} from './card-setup-information.js';
import {CardSetupPIN} from './card-setup-pin.js';

export const SetupCardView = observer(
  ({view}: RouteComponentProps<Router['safe']['setupCard']>): ReactNode => {
    const {router, errorService, copyItemsStore} = useEntrances();
    const [copyFlow] = useState(() =>
      view.copyId ? copyItemsStore.get(view.copyId) : undefined,
    );
    const isViewActive = useViewActive(view);
    const scanPrompt = useIsoDepScanPrompt();
    const mounted = useRef(true);
    const operationState = useRef<
      'idle' | 'working' | 'installed' | 'completing' | 'complete'
    >('idle');
    const [busy, setBusy] = useState(false);
    const [complete, setComplete] = useState(false);
    const [interrupted, setInterrupted] = useState(false);
    const [information, setInformation] = useState(() => view.cardInformation);
    const [showDetails, setShowDetails] = useState(false);
    const [pendingPIN, setPendingPIN] = useState<MonoidAppletHello>();
    const [showPINSetup, setShowPINSetup] = useState(false);

    useEffect(() => {
      mounted.current = true;

      return () => {
        mounted.current = false;
      };
    }, []);

    useEffect(
      () =>
        reaction(
          () => !isViewActive(),
          inactive => {
            if (inactive) setShowPINSetup(false);
          },
        ),
      [isViewActive],
    );

    const isActive = (): boolean => mounted.current && isViewActive();

    const completeSetup = async (hello: MonoidAppletHello): Promise<void> => {
      if (
        !isActive() ||
        operationState.current === 'completing' ||
        operationState.current === 'complete'
      )
        return;

      operationState.current = 'completing';
      setPendingPIN(hello);
      try {
        await copyFlow?.session.addTarget(hello);
        operationState.current = 'complete';
        if (mounted.current) {
          setPendingPIN(undefined);
          setComplete(true);
        }
      } finally {
        if (operationState.current === 'completing') {
          operationState.current = 'installed';
        }
      }
    };

    const scan = async (): Promise<void> => {
      const installing = information !== undefined;

      if (
        (installing && !hasAppletBundle) ||
        operationState.current !== 'idle' ||
        !isActive()
      ) {
        return;
      }

      operationState.current = 'working';
      setBusy(true);
      setInterrupted(false);

      try {
        let scannedInformation: CardInformation | undefined;
        let installed: MonoidAppletHello | undefined;

        await scanPrompt(
          installing ? 'Scan the card to install applets' : 'Scan a card',
          async (sessionId, setStateContent, signal) => {
            setStateContent('Reading card information, hold tight...');
            scannedInformation = await readCardInformation(sessionId, signal);

            signal.throwIfAborted();

            if (!isActive()) {
              return;
            }

            if (installing) {
              const expected = information.cplc;
              const actual = scannedInformation.cplc;

              if (
                expected &&
                (!actual ||
                  expected.icFabricator !== actual.icFabricator ||
                  expected.icType !== actual.icType ||
                  expected.icSerialNumber !== actual.icSerialNumber)
              ) {
                throw new MonoidCardError('Wrong card');
              }

              installed = await installMonoidApplets(
                sessionId,
                update => {
                  if (mounted.current) {
                    setStateContent(
                      <AppletInstallProgressContent update={update} />,
                    );
                  }
                },
                signal,
              );
            }
          },
        );

        if (!isActive() || (installing && !installed)) {
          return;
        }

        if (installing) {
          operationState.current = 'installed';
          setShowDetails(false);
          if (
            installed &&
            (installed.pins.access === false || installed.pins.safe === false)
          ) {
            setPendingPIN(installed);
            setShowPINSetup(true);
          } else if (installed) {
            await completeSetup(installed);
          }
        } else {
          setInformation(scannedInformation);
        }
      } catch (error) {
        if (!isActive()) {
          return;
        }

        setInterrupted(installing && operationState.current !== 'installed');

        if (!isCredentialRequestCancelled(error)) {
          throw error;
        }
      } finally {
        if (operationState.current === 'working') {
          operationState.current = 'idle';
        }

        if (mounted.current) {
          setBusy(false);
        }
      }
    };

    const backToCopy = complete
      ? router.$backTo(router.safe.copyItems.$exact)
      : undefined;
    const back = complete
      ? (backToCopy ?? router.$backTo(router.safe.$exact))
      : undefined;

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Setup card</ViewHeaderTitle>
          {information && !complete && (
            <ViewHeaderButton
              aria-label="Card information"
              aria-haspopup="dialog"
              aria-expanded={showDetails}
              onClick={() => setShowDetails(true)}
            >
              <AppIcon icon={info} aria-hidden="true" />
            </ViewHeaderButton>
          )}
        </ViewHeader>
        <ViewContent
          footer={
            complete ? (
              back && (
                <Button color="neutral" onClick={() => back()}>
                  {backToCopy ? 'Back to Copy' : 'Back to Safe'}
                </Button>
              )
            ) : pendingPIN ? (
              <Button onClick={() => setShowPINSetup(true)}>
                {pendingPIN.pins.safe === false
                  ? 'Set Safe PIN'
                  : pendingPIN.pins.access === false
                    ? 'Set Access PIN'
                    : 'Continue'}
              </Button>
            ) : (
              <Button
                disabled={information !== undefined && !hasAppletBundle}
                loading={busy}
                onClick={errorService.catch(scan)}
              >
                {!information
                  ? 'Read card'
                  : interrupted
                    ? 'Try again'
                    : 'Install applets'}
              </Button>
            )
          }
        >
          {complete ? (
            <OperationComplete />
          ) : (
            <>
              {information ? (
                <CardSetupInformation information={information} />
              ) : (
                <InfoSectionItemLabel>
                  Scan a card to read its information before installation
                </InfoSectionItemLabel>
              )}
              {!hasAppletBundle && (
                <InfoSectionItemLabel>
                  Applet package not available yet
                </InfoSectionItemLabel>
              )}
            </>
          )}
        </ViewContent>
        {showDetails && information && !complete && (
          <DetailsPopup
            onDismiss={() => setShowDetails(false)}
            aria-label="Card information"
            initialFocus="dialog"
          >
            <DetailsPopupTitle>Card information</DetailsPopupTitle>
            <DetailsPopupDivider />
            <CardInformationDetails information={information} />
          </DetailsPopup>
        )}
        {showPINSetup && pendingPIN && isActive() && (
          <CardSetupPIN
            hello={pendingPIN}
            onFinished={errorService.catch(async (initialized, current) => {
              if (!isActive()) return;
              setShowPINSetup(false);
              if (initialized && current) {
                await completeSetup(current);
              } else if (current) {
                setPendingPIN(current);
              }
            })}
          />
        )}
      </View>
    );
  },
);
