import {Clipboard} from '@capacitor/clipboard';
import {IonIcon} from '@ionic/react';
import check from 'lucide-static/icons/check.svg';
import copy from 'lucide-static/icons/copy.svg';
import ms from 'ms';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {useTemporaryState} from '../@hooks/interactions.js';

import {inlineIconCSS, inlineIconRowCSS} from './inline-icon.js';

const Container = styled.button`
  ${inlineIconRowCSS}
  position: relative;
  flex-shrink: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;

  &::after {
    content: '';
    position: absolute;
    inset: -4px;
  }
`;

const Icon = styled(IonIcon)<{$copied: boolean}>`
  ${inlineIconCSS}
  ${({$copied}) => $copied && 'color: var(--ion-color-safe);'}
`;

const COPIED_STATE_DURATION = ms('1s');

export function CopyButton({
  value,
  label,
  children,
  className,
}: {
  value: string;
  label: string;
  children?: ReactNode;
  className?: string;
}): ReactNode {
  const {errorService} = useEntrances();
  const [copied, setCopied] = useTemporaryState(false, COPIED_STATE_DURATION);

  return (
    <Container
      type="button"
      className={className}
      aria-label={label}
      title={copied ? 'Copied' : label}
      onClick={errorService.catch(async () => {
        await Clipboard.write({string: value});
        setCopied(true);
      })}
    >
      {children}
      <Icon icon={copied ? check : copy} $copied={copied} aria-hidden="true" />
    </Container>
  );
}
