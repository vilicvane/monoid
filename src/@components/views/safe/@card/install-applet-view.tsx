import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import {
  type MonoidApplet,
  hasAppletBundle,
  installMonoidApplets,
} from '../../../../@lib/monoid/index.js';
import type {Router} from '../../../../@routes.js';
import {isCredentialRequestCancelled} from '../../../../@services/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {Button} from '../../../@ui/button.js';
import {
  InfoSection,
  InfoSectionItemLabel,
  InfoSectionTitle,
} from '../../../@ui/info-section.js';
import {Step, Steps} from '../../../@ui/step.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';

export const InstallAppletView = ({
  view,
}: RouteComponentProps<Router['safe']['installApplet']>): ReactNode => {
  const {router, errorService} = useEntrances();
  const scanPrompt = useIsoDepScanPrompt();
  const mounted = useRef(true);
  const [installing, setInstalling] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [step, setStep] = useState(1);
  const [progress, setProgress] = useState<number>();

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const install = async (): Promise<void> => {
    setInstalling(true);
    setInterrupted(false);
    setStep(1);
    setProgress(undefined);

    let hello: Awaited<ReturnType<MonoidApplet['hello']>> | undefined;

    try {
      await scanPrompt(
        'Hold the card against your phone to install',
        async (sessionId, setStateContent) => {
          hello = await installMonoidApplets(sessionId, update => {
            if (!mounted.current) {
              return;
            }

            const stage = INSTALL_STAGES[update.stage];
            const percentage =
              update.progress === undefined
                ? undefined
                : Math.round(update.progress * 100);

            setStep(stage.number);
            setProgress(percentage);
            setStateContent(
              <>
                {stage.label}
                {percentage === undefined ? '' : ` ${percentage}%`}
                <br />
                Keep the card in place
              </>,
            );
          });
        },
      );

      if (
        !mounted.current ||
        view.$leaving ||
        !view.$match.$exact.$active ||
        !hello
      ) {
        return;
      }

      if (hello.pin === false) {
        router.safe
          .setupCard({
            id: uint8ArrayToHex(hello.id),
            pin: false,
            safe: {
              id: uint8ArrayToHex(hello.safe.id),
              pin: hello.safe.pin !== false,
              unlocked: hello.safe.unlocked,
            },
          })
          .$replace();
      } else {
        router.safe.scanCard.$replace();
      }
    } catch (error) {
      if (!mounted.current) {
        return;
      }

      setInterrupted(true);

      if (!isCredentialRequestCancelled(error)) {
        throw error;
      }
    } finally {
      if (mounted.current) {
        setInstalling(false);
      }
    }
  };

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Install Applet</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent
        footer={
          <Button
            disabled={!hasAppletBundle}
            loading={installing}
            onClick={errorService.catch(install)}
          >
            {interrupted ? 'Try again' : 'Install Applet'}
          </Button>
        }
      >
        <InfoSection>
          <InfoSectionTitle>Install Monoid Applet</InfoSectionTitle>
          <InfoSectionItemLabel>
            {hasAppletBundle
              ? 'Keep the card against your phone until installation finishes.'
              : 'Waiting for the applet package.'}
          </InfoSectionItemLabel>
          <InfoSectionItemLabel>
            Supports cards with factory-default management keys.
          </InfoSectionItemLabel>
          {interrupted && (
            <InfoSectionItemLabel role="status">
              Installation was interrupted. Try again to check the card and
              continue.
            </InfoSectionItemLabel>
          )}
          <Steps>
            {Object.entries(INSTALL_STAGES).map(([stage, item]) => (
              <Step
                key={stage}
                title={item.label}
                numero={item.number}
                activeNumero={step}
                processing={installing && item.number === step}
              >
                {installing && progress !== undefined ? `${progress}%` : null}
              </Step>
            ))}
          </Steps>
        </InfoSection>
      </ViewContent>
    </View>
  );
};

const INSTALL_STAGES = {
  checking: {number: 1, label: 'Checking card'},
  safe: {number: 2, label: 'Installing Safe'},
  monoid: {number: 3, label: 'Installing Monoid'},
  verifying: {number: 4, label: 'Verifying installation'},
};
