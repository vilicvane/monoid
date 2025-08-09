import {closeOutline} from 'ionicons/icons';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {useMonoidScanPrompt} from '../../../@monoid/monoid-scan-prompt.js';
import {Button, Buttons} from '../../../@ui/button.js';
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
    useMonoidScanPrompt(false);

  const onSetSafePINScanButtonClick = errorService.catch(
    async (): Promise<void> => {
      const safePIN = await showSafePINInput({
        // type: 'password',
        placeholder: 'Enter safe PIN',
        center: true,
      });

      if (!MonoidPIN.is(safePIN)) {
        toast({
          message: 'Incorrect PIN format, expected 6 to 16 characters.',
          color: 'danger',
          icon: closeOutline,
          position: 'top',
        });
        return;
      }

      await settingSafePINScanPrompt(async (applet, setStateContent) => {
        setStateContent(
          toUnlockSafe ? 'Unlocking safe...' : 'Setting safe PIN...',
        );

        await applet.setPIN({
          ...(toUnlockSafe
            ? {
                auth: {
                  pin: safePIN,
                  safe: true,
                },
              }
            : undefined),
          pin: safePIN,
          safe: true,
        });

        setStep(step + 1);
      });
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
        <ViewContent>
          <Steps>
            <Step
              title={toUnlockSafe ? 'Unlock safe' : 'Set safe pin'}
              numero={1}
              activeNumero={step}
            />
          </Steps>
          <Buttons id="buttons">
            {step === 1 && (
              <Button onClick={onSetSafePINScanButtonClick}>Scan</Button>
            )}
          </Buttons>
        </ViewContent>
      </View>
      {safePINInput}
      {settingSafePINScanPromptContent}
    </>
  );
};
