import {IonIcon, IonRippleEffect} from '@ionic/react';
import classNames from 'classNames';
import {computeAddress} from 'ethers';
import {cardOutline, checkmark} from 'ionicons/icons';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import type {Router} from '../../../@routes.js';
import {Address} from '../../@ui/address.js';
import {Button} from '../../@ui/button.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../@view/index.js';

import type {ScannedCardKeyData} from './common.js';

const Id = styled.div`
  color: var(--ion-color-medium);
  background-color: var(--ion-color-light);
  border-radius: 4px;

  height: 24px;
  padding: 0 6px 0 4px;
  border: solid 0.5px var(--ion-color-light-shade);

  display: flex;
  align-items: center;
  gap: 4px;
`;

const IdIcon = styled(IonIcon)`
  font-size: 20px;
`;

const IdNumber = styled.span``;

const List = styled.div`
  flex: 1;

  margin: 0 calc(-1 * var(--view-padding));
`;

const Buttons = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const CardView = ({
  view,
}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Card</ViewHeaderTitle>
        <Id>
          <IdIcon icon={cardOutline} />
          <IdNumber>{view.card.id}</IdNumber>
        </Id>
      </ViewHeader>
      <ViewContent>
        <List>
          {view.card.keys.map(key => (
            <KeyItem key={key.index} data={key} />
          ))}
        </List>
        <Buttons>
          <Button>Import</Button>
        </Buttons>
      </ViewContent>
    </View>
  );
};

const Item = styled.div`
  position: relative;
  display: flex;

  align-items: center;
  justify-content: space-between;
  gap: 8px;

  padding: 12px var(--view-padding);

  overflow: hidden;
`;

const ItemContent = styled.div`
  flex: 1;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const KeyTags = styled.div`
  display: flex;
  gap: 10px;
`;

const KeyTag = styled.div`
  margin: 0 -2px;

  line-height: 22px;
  padding: 0 6px;
  font-size: 13px;
  border-radius: 12px;

  background-color: var(--ion-color-light);
  border: solid 0.5px var(--ion-color-light-shade);
  color: var(--ion-color-medium-shade);
`;

const KeyCheckbox = styled(KeyTag)`
  width: 22px;
  padding: 0;

  background-color: var(--ion-color-dark-contrast);
  border-color: var(--ion-color-light-shade);

  display: flex;
  align-items: center;
  justify-content: center;

  transition: all 0.2s linear;

  &.checked {
    background-color: var(--ion-color-primary);
    border-color: var(--ion-color-primary-shade);
    color: var(--ion-color-primary-contrast);
  }
`;

const KeyType = styled(KeyTag)`
  &.seed {
    background-color: var(--color-seed-light);
    border-color: var(--color-seed-light-shade);
    color: var(--color-seed-light-contrast);
  }

  &.master {
    background-color: var(--color-master-light);
    border-color: var(--color-master-light-shade);
    color: var(--color-master-light-contrast);
  }
`;

const KeyAlias = styled(KeyTag)`
  background-color: var(--ion-color-primary);
  border-color: var(--ion-color-primary-shade);
  color: var(--ion-color-primary-contrast);
`;

const KeyDerivation = styled(KeyTag)`
  background-color: var(--ion-color-dark-contrast);
  border-color: var(--ion-color-light-shade);
  color: var(--ion-color-dark);
`;

const KeyRefAddress = styled(Address)`
  color: var(--ion-color-dark);
`;

const KeyItem = ({data}: {data: ScannedCardKeyData}): ReactNode => {
  const address = useMemo(
    () => computeAddress(`0x${data.refPublicKey}`),
    [data.refPublicKey],
  );

  const [checked, setChecked] = useState(true);

  return (
    <Item className="ion-activatable" onClick={() => setChecked(!checked)}>
      <ItemContent>
        <KeyTags>
          <KeyCheckbox className={classNames({checked})}>
            <IonIcon icon={checkmark} />
          </KeyCheckbox>
          <KeyType className={data.type}>{data.type}</KeyType>
          {(data.type === 'seed' || data.type === 'master') && (
            <KeyDerivation>m/44'/60'/0'/0</KeyDerivation>
          )}
          {data.alias && <KeyAlias>{data.alias}</KeyAlias>}
        </KeyTags>
        <KeyRefAddress>{address}</KeyRefAddress>
      </ItemContent>
      <IonRippleEffect />
    </Item>
  );
};
