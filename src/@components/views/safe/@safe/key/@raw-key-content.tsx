import type {ReactNode} from 'react';

import type {WalletKeyData} from '../../../../../@services/index.js';
import {
  InfoSection,
  InfoSectionItem,
  InfoSectionItemContent,
  InfoSectionItemLabel,
} from '../../../../@ui/info-section.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
import {ViewContent} from '../../../../@view/index.js';

export const RawKeyContent = ({
  data: {
    wallets: [wallet],
  },
}: {
  data: WalletKeyData;
}): ReactNode => {
  return (
    <ViewContent>
      <InfoSection>
        <InfoSectionItem>
          <InfoSectionItemLabel>Address</InfoSectionItemLabel>
          <InfoSectionItemContent>
            <InteractiveAddress copyable>{wallet.address}</InteractiveAddress>
          </InfoSectionItemContent>
        </InfoSectionItem>
      </InfoSection>
    </ViewContent>
  );
};
