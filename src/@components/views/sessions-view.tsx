import type {ReactNode} from 'react';

import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

export const SessionsView = (): ReactNode => {
  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Sessions</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>This is the sessions view content.</ViewContent>
    </View>
  );
};
