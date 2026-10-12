import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import {card} from 'ionicons/icons';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {MonoidApplet} from '../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {breathAnimationCSS} from '../@animations.js';

const Backdrop = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);

  display: flex;
  align-items: center;
  justify-content: center;
`;

const PromptContainer = styled.div`
  box-sizing: border-box;
  width: 100%;
  padding: 40px 20px;
  background-color: var(--ion-color-dark-contrast);

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
`;

const Icon = styled(IonIcon)`
  font-size: 72px;
  color: var(--ion-color-primary);

  &.scanning {
    ${breathAnimationCSS}
  }

  &.error {
    color: var(--ion-color-danger);
  }
`;

const PromptStateContent = styled.div`
  margin-top: 10px;
  margin-bottom: -20px;
  height: 50px;
  line-height: 25px;
  text-align: center;
  font-size: 14px;
  color: var(--ion-color-medium-tint);

  &.error {
    color: var(--ion-color-danger);
  }
`;

export const MonoidScanStatePromptContentHighlight = styled.span`
  color: var(--ion-color-medium);
`;

export type MonoidScanPromptSetStateContentCallback = (
  content: ReactNode,
) => void;

export function useMonoidScanPrompt(
  ensureSetup = true,
): [
  ReactNode,
  (
    initialStateContent: ReactNode,
    appletCallback: (
      applet: MonoidApplet,
      setStateContent: MonoidScanPromptSetStateContentCallback,
    ) => Promise<void>,
  ) => Promise<void>,
] {
  const {router, monoidApplet} = useEntrances();

  const [appletCallbackAndPromise, setAppletCallbackAndPromise] =
    useState<
      [
        (
          applet: MonoidApplet,
          setStateContent: MonoidScanPromptSetStateContentCallback,
        ) => Promise<void>,
        {resolve: () => void; reject: (error: unknown) => void},
      ]
    >();

  const [state, setState] = useState<'ready' | 'scanning' | 'error'>('ready');

  const [stateContent, setStateContent] = useState<ReactNode>();

  useEffect(() => {
    if (!appletCallbackAndPromise) {
      return;
    }

    const [appletCallback, {resolve, reject}] = appletCallbackAndPromise;

    return monoidApplet.standby(
      async applet => {
        setState('scanning');

        if (ensureSetup) {
          setStateContent('Greeting to monoid...');

          const hello = await applet.hello({});

          if (hello.pin === false) {
            router.safe
              .setupCard({
                id: uint8ArrayToHex(hello.id),
                pin: hello.pin !== false,
                safe: {
                  id: uint8ArrayToHex(hello.safe.id),
                  pin: hello.safe.pin !== false,
                  unlocked: hello.safe.unlocked,
                },
              })
              .$push();

            return;
          }
        }

        await appletCallback(applet, setStateContent);

        setState('ready');

        resolve();
      },
      error => {
        setState('error');

        reject(error);

        console.error('Error during Monoid applet standby:', error);
      },
      () => {
        setAppletCallbackAndPromise(undefined);
      },
    );
  }, [monoidApplet, ensureSetup, router.safe, appletCallbackAndPromise]);

  const content = appletCallbackAndPromise && (
    <Backdrop onClick={() => setAppletCallbackAndPromise(undefined)}>
      <PromptContainer>
        <Icon
          className={classNames({
            error: state === 'error',
            scanning: state !== 'ready' && state !== 'error',
          })}
          icon={card}
        />
        <PromptStateContent
          className={classNames({
            [state]: true,
          })}
        >
          {state === 'error' ? 'Oops, an error occurred.' : stateContent}
        </PromptStateContent>
      </PromptContainer>
    </Backdrop>
  );

  return [
    content,
    useCallback(
      (initialStateContent, appletCallback) =>
        new Promise((resolve, reject) => {
          setState('ready');
          setStateContent(initialStateContent);

          setAppletCallbackAndPromise([appletCallback, {resolve, reject}]);
        }),
      [],
    ),
  ];
}
