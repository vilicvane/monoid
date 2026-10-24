import {Clipboard} from '@capacitor/clipboard';
import {Check as check, Copy as copy} from 'lucide-react';
import ms from 'ms';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {useTemporaryState} from '../@hooks/interactions.js';

import {AppIcon} from './app-icon.js';
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

const Icon = styled(AppIcon)<{$copied: boolean}>`
  ${inlineIconCSS}
  ${({$copied}) => $copied && 'color: var(--ion-color-safe);'}
`;

const COPIED_STATE_DURATION = ms('1s');

export function CopyButton({
  value,
  label,
  children,
  className,
  showIcon = true,
}: {
  value: string | (() => string | undefined);
  label: string;
  children?: ReactNode;
  className?: string;
  showIcon?: boolean;
}): ReactNode {
  const {errorService} = useEntrances();
  const [copied, setCopied] = useTemporaryState(false, COPIED_STATE_DURATION);

  return (
    <Container
      type="button"
      className={className}
      aria-label={label}
      title={copied ? 'Copied' : label}
      data-copied={copied || undefined}
      onClick={errorService.catch(async () => {
        const currentValue = typeof value === 'function' ? value() : value;
        if (currentValue === undefined) return;
        await Clipboard.write({string: currentValue});
        setCopied(true);
      })}
    >
      {children}
      {showIcon && (
        <Icon
          icon={copied ? check : copy}
          $copied={copied}
          aria-hidden="true"
        />
      )}
    </Container>
  );
}
