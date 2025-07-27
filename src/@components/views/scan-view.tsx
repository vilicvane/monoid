import type {ReactNode} from 'react';

import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

export const ScanView = (): ReactNode => {
  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>Scan</ViewHeaderTitle>
      </ViewHeader>
      <ViewContent>This is the scan view content.</ViewContent>
    </View>
  );
};
