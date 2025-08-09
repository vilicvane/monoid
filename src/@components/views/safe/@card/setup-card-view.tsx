import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {useMonoidScanPrompt} from '../../../@monoid/monoid-scan-prompt.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {Input} from '../../../@ui/input.js';
import {Step, Steps} from '../../../@ui/step.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../@view/index.js';

const PINInput = styled(Input)`
  &:not(:focus):invalid {
    outline: 2px solid var(--ion-color-danger);
    outline-offset: -1px;
  }
`;

export const SetupCardView = ({
  view,
}: RouteComponentProps<Router['safe']['setupCard']>): ReactNode => {
  const {errorService} = useEntrances();

  const [pinSet, setPinSet] = useState(view.pin);
  const [safePinSet, setSafePinSet] = useState(view.safe.pin);
  const [safeUnlocked, setSafeUnlocked] = useState(view.safe.unlocked);

  const [step, setStep] = useState(() => {
    if (!view.safe.pin || !view.safe.unlocked) {
      return 1;
    }

    return 2;
  });

  const [toUnlockSafe] = useState(() => view.safe.pin !== false);
  const [safePin, setSafePin] = useState('');

  const step1_safePinReady = useMemo(() => MonoidPIN.is(safePin), [safePin]);

  const step2_pinReady = useMemo(() => MonoidPIN.is(pinSet), [pinSet]);

  const [settingSafePinScanPromptContent, settingSafePinScanPrompt] =
    useMonoidScanPrompt(false);

  const onSaveSafePinButtonClick = (): void => {
    errorService.catch(
      settingSafePinScanPrompt(async (applet, setStateContent) => {
        setStateContent(
          toUnlockSafe ? 'Unlocking safe...' : 'Setting safe pin...',
        );

        await applet.setPIN({
          ...(toUnlockSafe
            ? {
                auth: {
                  pin: safePin,
                  safe: true,
                },
              }
            : undefined),
          pin: safePin,
          safe: true,
        });

        setStep(step + 1);
      }),
    );
  };

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
            >
              <PINInput
                type="password"
                value={safePin}
                required
                minLength={6}
                maxLength={16}
                onChange={event => setSafePin(event.target.value)}
              />
            </Step>
          </Steps>
          <Buttons>
            {step === 1 && (
              <Button onClick={onSaveSafePinButtonClick}>Next</Button>
            )}
          </Buttons>
        </ViewContent>
      </View>
      {settingSafePinScanPromptContent}
    </>
  );
};
