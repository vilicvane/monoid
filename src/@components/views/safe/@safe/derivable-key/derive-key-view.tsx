import {IonFab, IonFabButton, IonIcon} from '@ionic/react';
import {checkmark} from 'ionicons/icons';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import type {RouteComponentProps} from 'routra-react';

import {BIP39PathString} from '../../../../../@atomics.js';
import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {Step, Steps} from '../../../../@ui/step.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../../@view/index.js';

export const DeriveKeyView = observer(
  ({
    view,
    transition,
  }: RouteComponentProps<
    Router['safe']['derivableKey']['derive']
  >): ReactNode => {
    const {portalsService} = useEntrances();

    // let {step, path, address} = view;

    // const stepReady0 = BIP39PathString.is(path);
    // const stepReady1 = address !== undefined;

    // step = Math.min(step, stepReady0 ? Infinity : 0, stepReady1 ? Infinity : 1);

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Derive Key</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          {/* <Steps>
            <Step
              title="Enter derivation path"
              active={step === 0}
              ready={stepReady0}
            >
              <input
                value={path}
                onChange={event => {
                  runInAction(() => {
                    view.path = event.target.value;
                  });
                }}
              />
            </Step>
            <Step
              title="Scan monoid card to derive key"
              active={step === 1}
              ready={stepReady1}
            >
              <p>Scan your monoid card to derive the key.</p>
            </Step>
          </Steps> */}
        </ViewContent>
        <ViewFab view={view} transition={transition}>
          <IonFabButton>
            <IonIcon icon={checkmark} />
          </IonFabButton>
        </ViewFab>
      </View>
    );
  },
);
