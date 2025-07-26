import {IonFab, IonFabButton, IonFabList, IonIcon} from '@ionic/react';
import classNames from 'classnames';
import {addOutline, copyOutline, downloadOutline, key} from 'ionicons/icons';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {popInAnimationCSS, popOutAnimationCSS} from '../@animations.js';

import {Tabs as Tabs_} from './@tabs.js';

const Container = styled.div`
  --nav-bar-height: 50px;

  border-top: solid 0.5px #eee;
  background-color: rgba(245, 245, 245, 0.8);
  backdrop-filter: blur(4px);

  display: flex;
`;

const Tabs = styled(Tabs_)`
  flex: 1;

  transition: padding-right 0.2s ease-out;
  transition-delay: 0.1s;

  ${Container}.fab-active & {
    transition-delay: 0s;
    padding-right: 25%;
  }
`;

const Fab = styled(IonFab)`
  opacity: 0;
  transform: scale(0);

  pointer-events: none;

  &.animate-in {
    ${popInAnimationCSS}

    pointer-events: unset;
  }

  &.animate-out {
    ${popOutAnimationCSS}
  }
`;

export const NavBar = observer((): ReactNode => {
  const {router} = useEntrances();

  const safeFabActive = router.safe.$active;

  const fabActive = safeFabActive;

  const [safeFabWasEverActive, setSafeFabWasEverActive] =
    useState(safeFabActive);

  useEffect(() => {
    setSafeFabWasEverActive(value => value || safeFabActive);
  }, [safeFabActive]);

  return (
    <Container
      className={classNames({
        'fab-active': fabActive,
      })}
    >
      <Tabs />
      <Fab
        className={
          safeFabActive
            ? 'animate-in'
            : safeFabWasEverActive
              ? 'animate-out'
              : undefined
        }
        vertical="top"
        horizontal="end"
        edge
      >
        <IonFabButton>
          <IonIcon icon={key} />
        </IonFabButton>
        <IonFabList side="top">
          <IonFabButton>
            <IonIcon icon={addOutline} />
          </IonFabButton>
          <IonFabButton onClick={() => router.safe.import.$push()}>
            <IonIcon icon={downloadOutline} />
          </IonFabButton>
          <IonFabButton>
            <IonIcon icon={copyOutline} />
          </IonFabButton>
        </IonFabList>
      </Fab>
    </Container>
  );
});
