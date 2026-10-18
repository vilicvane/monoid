import {X as x} from 'lucide-react';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {renderIcon} from '../../../../@lib/render-icon.js';
import type {Router} from '../../../../@routes.js';
import {
  MonoidScanStatePromptContentHighlight,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {Button} from '../../../@ui/button.js';
import {Step, Steps} from '../../../@ui/step.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../@view/index.js';

export const SetupCardView = ({
  view,
}: RouteComponentProps<Router['safe']['setupCard']>): ReactNode => {
  const {errorService} = useEntrances();

  const toast = useToast();

  const [pinSet, setPINSet] = useState(view.pin);
  const [safePINSet, setSafePINSet] = useState(view.safe.pin);
  const [safeUnlocked, setSafeUnlocked] = useState(view.safe.unlocked);

  const [step, setStep] = useState(() => {
    if (!view.safe.pin || !view.safe.unlocked) {
      return 1;
    }

    return 2;
  });

  const [safePINInput, showSafePINInput] = useInputModal();

  const [toUnlockSafe] = useState(() => view.safe.pin !== false);
  const [safePIN, setSafePIN] = useState<string>();

  const step1_safePINReady = useMemo(() => MonoidPIN.is(safePIN), [safePIN]);

  const step2_pinReady = useMemo(() => MonoidPIN.is(pinSet), [pinSet]);

  const [settingSafePINScanPromptContent, settingSafePINScanPrompt] =
    useMonoidScanPrompt({ensureSetup: false});

  const onSetSafePINScanButtonClick = errorService.catch(
    async (): Promise<void> => {
      const safePIN = await showSafePINInput({
        type: 'password',
        placeholder: 'Enter Safe PIN',
        description: view.pin
          ? undefined
          : 'Will be used as initial Access PIN',
        center: true,
      });

      if (!MonoidPIN.is(safePIN)) {
        toast({
          message: 'Incorrect PIN format, expected 6 to 16 characters.',
          color: 'danger',
          icon: renderIcon(x),
          position: 'top',
        });
        return;
      }

      await settingSafePINScanPrompt(
        <>
          Scan card{' '}
          <MonoidScanStatePromptContentHighlight>
            {view.safe.id}
          </MonoidScanStatePromptContentHighlight>
        </>,
        async (applet, setStateContent) => {
          setStateContent(
            toUnlockSafe ? 'Unlocking safe...' : 'Setting Safe PIN...',
          );

          if (toUnlockSafe) {
            await applet.authenticate({
              pin: safePIN,
              safe: true,
            });
          }

          await applet.setPIN({
            pin: safePIN,
            safe: true,
          });

          setStep(step + 1);
        },
      );
    },
  );

  return (
    <>
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Setup Card</ViewHeaderTitle>
          <ViewHeaderIdentifier
            identifier={{
              type: 'card',
              id: view.safe.id,
            }}
          />
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          footer={
            step === 1 && (
              <Button onClick={onSetSafePINScanButtonClick}>
                {toUnlockSafe ? 'Unlock safe' : 'Set Safe PIN'}
              </Button>
            )
          }
        >
          <Steps>
            <Step
              title={toUnlockSafe ? 'Unlock safe' : 'Set Safe PIN'}
              numero={1}
              activeNumero={step}
            />
          </Steps>
        </ViewContent>
      </View>
      {safePINInput}
      {settingSafePINScanPromptContent}
    </>
  );
};
