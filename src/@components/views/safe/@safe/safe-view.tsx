import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';

import {KeyItem} from './@key-item.js';

const List = styled.div`
  flex: 1;
  margin: 0 calc(-1 * var(--view-padding));
`;

export const SafeView = observer((): ReactNode => {
  const {walletStorageService} = useEntrances();

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Safe</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>
        <List>
          {walletStorageService.keys.map(key => (
            <KeyItem key={key.index} data={key} />
          ))}
        </List>
      </ViewContent>
    </View>
  );
});
