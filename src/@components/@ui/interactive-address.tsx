import {Clipboard} from '@capacitor/clipboard';
import {IonIcon, useIonToast} from '@ionic/react';
import classNames from 'classNames';
import checkCheck from 'lucide-static/icons/check-check.svg';
import copy from 'lucide-static/icons/copy.svg';
import ms from 'ms';
import type {HTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {useTemporaryState} from '../@hooks/interactions.js';

import {Address as Address_} from './address.js';

const Container = styled.div<{$copyable: boolean}>`
  position: relative;
  padding-right: ${({$copyable}) => ($copyable ? '20px' : '0')};

  display: flex;
  align-items: center;
`;

const Address = styled(Address_)`
  flex: 1;
  min-width: 0;

  &.clickable {
    text-decoration: underline;
  }
`;

const CopyButton = styled.button`
  position: absolute;
  top: 50%;
  right: -4px;
  transform: translateY(-50%);

  width: 24px;
  height: 24px;

  display: flex;
  align-items: center;
  justify-content: center;

  font-size: inherit;
  background: transparent;
  color: var(--ion-color-medium);
`;

const COPIED_STATE_DURATION = ms('1s');

const COPIED_TOAST_DURATION = ms('2s');

export const InteractiveAddress = ({
  clickable = false,
  copyable = false,
  children: address,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  clickable?: boolean;
  copyable?: boolean;
  children: string;
}): ReactNode => {
  const {errorService} = useEntrances();

  const [copied, setCopied] = useTemporaryState(false, COPIED_STATE_DURATION);

  const [toast] = useIonToast();

  return (
    <Container {...props} $copyable={copyable}>
      <Address
        className={classNames({
          clickable,
        })}
        onClick={
          clickable
            ? () => open(`https://etherscan.io/address/${address}`)
            : undefined
        }
      >
        {address}
      </Address>
      {copyable && (
        <CopyButton
          type="button"
          aria-label="Copy address"
          onClick={errorService.catch(async () => {
            await Clipboard.write({
              string: address,
            });

            await toast({
              icon: copy,
              message: 'Address copied to clipboard',
              duration: COPIED_TOAST_DURATION,
              positionAnchor: 'nav-bar',
            });

            setCopied(true);
          })}
        >
          <IonIcon icon={copied ? checkCheck : copy} />
        </CopyButton>
      )}
    </Container>
  );
};
