import {type ReactNode, useEffect} from 'react';

import {useEntrances} from '../../../@entrances.js';
import {View} from '../../@view.js';

export const SafeImportView = (): ReactNode => {
  const {monoidApplet} = useEntrances();

  useEffect(
    () =>
      monoidApplet.standby(async applet => {
        const response = await applet.hello({});

        console.log('Hello response:', response);
      }),
    [monoidApplet],
  );

  return <View>Safe Import View</View>;
};
