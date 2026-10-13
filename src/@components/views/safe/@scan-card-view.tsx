import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import {card} from 'ionicons/icons';
import {type ReactNode, useCallback, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../@entrances.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {Router} from '../../../@routes.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';
import {
  breathAnimationCSS,
  scaleInAnimationCSS,
  scaleOutAnimationCSS,
} from '../../@animations.js';
import {useMonoidApplet} from '../../@monoid/use-monoid-applet.js';
import {View} from '../../@view/index.js';

import {scanCardKeys} from './scan-card.js';

const ScanCardGuideContainer = styled.div`
  flex: 1;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  ${scaleInAnimationCSS}

  &.leaving {
    ${scaleOutAnimationCSS}
  }
`;

const Icon = styled(IonIcon)`
  font-size: 72px;
  color: var(--ion-color-primary);

  &.working {
    ${breathAnimationCSS}
  }

  &.error {
    color: var(--ion-color-danger);
  }
`;

export const ScanCardView = ({
  view,
  transition,
}: RouteComponentProps<Router['safe']['scanCard']>): ReactNode => {
  const {router} = useEntrances();

  useEffect(
    () =>
      view.$transition({
        leaving: true,
      }),
    [view],
  );

  const [[state, index, total, code], setScanningState] = useState<
    [ScanningState, number, number, string?]
  >(['ready', 0, 0, undefined]);

  const monoidAppletContent = useMonoidApplet(
    {auth: 'access'},
    useCallback(
      async (applet, hello) => {
        setScanningState(['listing', 0, 0]);

        const keys = await scanCardKeys(applet, (index, total) => {
          setScanningState(['viewing', index, total]);
        });

        setScanningState(['complete', 0, 0]);

        router.safe
          .card({
            card: {
              id: uint8ArrayToHex(hello.safe.id),
              keys,
            },
          })
          .$push();
      },
      [router.safe],
    ),
    error => {
      console.error(error);
      setScanningState([
        'error',
        0,
        0,
        error instanceof CBORAppletError ? error.source.code : undefined,
      ]);
    },
  );

  return (
    <>
      <View animation={false}>
        <ScanCardGuideContainer
          className={classNames({
            leaving: view.$leaving,
          })}
          {...transition.events}
        >
          <Icon
            className={classNames({
              error: state === 'error',
              working: state !== 'ready' && state !== 'error',
            })}
            icon={card}
          />
          {SCANNING_STATE_TO_TEXT[state](index, total, code)}
        </ScanCardGuideContainer>
      </View>
      {monoidAppletContent}
    </>
  );
};

const ScanningStateText = styled.div`
  margin-top: 10px;
  margin-bottom: -20px;
  height: 50px;
  line-height: 25px;
  text-align: center;
  color: var(--ion-color-medium-tint);

  &.smaller {
    font-size: 14px;
  }

  &.error {
    color: var(--ion-color-danger);
  }
`;

const ScanningStateTextHighlight = styled.span`
  color: var(--ion-color-medium);
`;

const ScanningStateTextFocus = styled.span`
  color: var(--ion-color-primary);
`;

type ScanningState = 'ready' | 'listing' | 'viewing' | 'complete' | 'error';

const SCANNING_STATE_TO_TEXT: Record<
  ScanningState,
  (index: number, total: number, code: string | undefined) => ReactNode
> = {
  ready: () => (
    <ScanningStateText>
      Scan a <ScanningStateTextHighlight>monoid</ScanningStateTextHighlight>{' '}
      card
    </ScanningStateText>
  ),
  listing: () => (
    <ScanningStateText className="smaller">
      <ScanningStateTextHighlight>
        Listing safe items...
      </ScanningStateTextHighlight>
    </ScanningStateText>
  ),
  viewing: (index, total) => (
    <>
      <ScanningStateText className="smaller">
        <ScanningStateTextHighlight>
          Fetching keys, hold tight...
        </ScanningStateTextHighlight>
        <br />
        <ScanningStateTextFocus>{index + 1}</ScanningStateTextFocus>/{total}
      </ScanningStateText>
    </>
  ),
  complete: () => (
    <ScanningStateText className="smaller">
      <ScanningStateTextHighlight>
        Scanning complete.
      </ScanningStateTextHighlight>
    </ScanningStateText>
  ),
  error: (_index, _total, code) => (
    <ScanningStateText className="smaller error">
      {code ? (
        <>
          Oops, an error occurred:
          <br />
          {code}
        </>
      ) : (
        <>Oops, an error occurred.</>
      )}
    </ScanningStateText>
  ),
};
