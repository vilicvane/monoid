import {keyOutline} from 'ionicons/icons';
import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {KeyType} from '../../../../@key/key-type.js';
import {Address} from '../../../../@ui/address.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../../@view/index.js';

import {DerivableKeyContent} from './@derivable-key-content.js';
import {RawKeyContent} from './@raw-key-content.js';

const INDEX_DISPLAY_OFFSET = 2;
const INDEX_DISPLAY_END = INDEX_DISPLAY_OFFSET + 8;

export const KeyView = ({
  view,
}: RouteComponentProps<Router['safe']['key']>): ReactNode => {
  const {router, walletStorageService} = useEntrances();

  const {index} = view;

  const key = walletStorageService.indexToKeyMap.get(index);

  useEffect(() => {
    if (!key) {
      router.safe.$reset();
    }
  }, [key, router.safe]);

  if (!key) {
    return null;
  }

  const {type, alias} = key;

  let content: ReactNode;

  switch (type) {
    case 'seed':
    case 'master':
      content = DerivableKeyContent({data: key});
      break;
    case 'secp256k1':
      content = RawKeyContent({data: key});
      break;
    default:
      content = null;
      break;
  }

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>
          <KeyType type={type} />
        </ViewHeaderTitle>
        <ViewHeaderIdentifier icon={keyOutline}>
          {alias ?? index.slice(INDEX_DISPLAY_OFFSET, INDEX_DISPLAY_END)}
        </ViewHeaderIdentifier>
      </ViewHeader>
      {content}
    </View>
  );
};
