import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import {
  View,
  ViewContent as ViewContent_,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';

import {KeyItem} from './@key-item.js';

const ViewContent = styled(ViewContent_)`
  padding-left: 0;
  padding-right: 0;
`;

export const SafeView = (): ReactNode => {
  const {walletStorageService} = useEntrances();

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Safe</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>
        {walletStorageService.keys.map(key => (
          <KeyItem key={key.index} data={key} />
        ))}
      </ViewContent>
    </View>
  );
};
