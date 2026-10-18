import {Clipboard} from '@capacitor/clipboard';
import ms from 'ms';
import {QRCodeSVG} from 'qrcode.react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {ADDRESS_TYPES, ADDRESS_TYPE_LABELS} from '../../@lib/wallet-address.js';
import type {WalletKeyWalletData} from '../../@services/index.js';
import {useTemporaryState} from '../@hooks/interactions.js';
import {Button} from '../@ui/button.js';
import {CenteredPopup} from '../@ui/centered-popup.js';
import {CenteredPopupAddress} from '../@ui/popup-address.js';

import {KeyDerivationTag, KeyTags} from './key-tags.js';

const Tags = styled(KeyTags)`
  justify-content: center;
`;

const QRCode = styled(QRCodeSVG)`
  align-self: center;
  flex-shrink: 0;
  width: 100%;
  height: auto;
  border-radius: 12px;
`;

const Address = styled(CenteredPopupAddress)`
  margin-bottom: 8px;
`;

const COPIED_STATE_DURATION = ms('2s');

export const ReceiveAddressPopup = ({
  wallet,
  onDismiss,
}: {
  wallet: WalletKeyWalletData;
  onDismiss: () => void;
}): ReactNode => {
  const {errorService} = useEntrances();
  const [copied, setCopied] = useTemporaryState(false, COPIED_STATE_DURATION);

  return (
    <CenteredPopup aria-label="Receive address" onDismiss={onDismiss}>
      <Tags>
        <KeyDerivationTag chain={ADDRESS_TYPES[wallet.addressType].chain}>
          {ADDRESS_TYPE_LABELS[wallet.addressType]}
        </KeyDerivationTag>
      </Tags>
      <QRCode
        value={wallet.address}
        size={240}
        level="M"
        marginSize={2}
        title="Receive address QR code"
      />
      <Address highlightEdges>{wallet.address}</Address>
      <Button
        aria-live="polite"
        onClick={errorService.catch(async () => {
          await Clipboard.write({string: wallet.address});
          setCopied(true);
        })}
      >
        {copied ? 'Copied' : 'Copy address'}
      </Button>
    </CenteredPopup>
  );
};
