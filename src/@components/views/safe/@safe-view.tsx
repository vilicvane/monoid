import type {ReactNode} from 'react';

import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../@view/index.js';

export const SafeView = (): ReactNode => {
  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Safe</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>This is the safe view content.</ViewContent>
    </View>
  );
};
