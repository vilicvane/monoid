import {parseSSHAccount} from '@monoid/ssh-protocol';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {CopyButton} from '../@ui/copy-button.js';
import {InfoSectionItemLabel} from '../@ui/info-section.js';
import {inlineIconRowCSS} from '../@ui/inline-icon.js';

import {KeyCheckbox} from './key-checkbox.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from './key-list.js';
import {KeyAliasTag, KeyParameterTag, KeyTags, KeyTypeTag} from './key-tags.js';

const FingerprintRow = styled.div`
  ${inlineIconRowCSS}

  > ${KeyListAddress} {
    flex: 1;
    min-width: 0;
  }
`;

export const SSHAccountList = observer(function SSHAccountList({
  accounts,
  selectionLabel,
  compact = false,
  compactContent = false,
  contained = false,
  selected = new Set(),
  additionalAccounts = [...selected],
  onToggle,
  disabled = false,
}: {
  accounts?: readonly string[];
  selectionLabel?: string;
  compact?: boolean;
  compactContent?: boolean;
  contained?: boolean;
  selected?: ReadonlySet<string>;
  additionalAccounts?: readonly string[];
  onToggle?: (account: string) => void;
  disabled?: boolean;
}): ReactNode {
  const {sshKeyStore, walletStorageService} = useEntrances();
  const keys = sshKeyStore.candidates(walletStorageService.keys);
  const list = [
    ...new Set(
      accounts ?? [...keys.map(key => key.account), ...additionalAccounts],
    ),
  ];
  return (
    <>
      {selectionLabel && list.length > 0 && (
        <InfoSectionItemLabel>{selectionLabel}</InfoSectionItemLabel>
      )}
      <KeyList
        $compact={compact}
        $compactContent={compactContent}
        $contained={contained}
      >
        {list.map(account => {
          const parsed = parseSSHAccount(account);
          const key = keys.find(key => key.account === account);
          const algorithm =
            parsed.algorithm === 'ssh-ed25519' ? 'ed25519' : 'secp256r1';
          const context = key?.type === 'seed' ? key.derivation.context : '';
          return (
            <KeyListItem as={onToggle ? 'label' : 'div'} key={account}>
              {onToggle && (
                <KeyCheckbox
                  checked={selected.has(account)}
                  disabled={disabled}
                  aria-label={`Select ${parsed.fingerprint}`}
                  onChange={() => onToggle(account)}
                />
              )}
              <KeyListItemContent>
                <KeyTags>
                  <KeyTypeTag
                    className={key?.type === 'seed' ? 'seed' : undefined}
                  >
                    {key?.type ?? algorithm}
                  </KeyTypeTag>
                  {key?.alias && <KeyAliasTag>{key.alias}</KeyAliasTag>}
                  {key?.type === 'seed' && (
                    <KeyParameterTag
                      title={context ? `${algorithm}: ${context}` : algorithm}
                      aria-label={
                        context
                          ? `${algorithm} derivation ${context}`
                          : algorithm
                      }
                    >
                      {context ? `${algorithm} ${context}` : algorithm}
                    </KeyParameterTag>
                  )}
                  {!key && <KeyListPlaceholder>Not in Safe</KeyListPlaceholder>}
                </KeyTags>
                {onToggle ? (
                  <KeyListAddress title={parsed.fingerprint}>
                    {parsed.fingerprint}
                  </KeyListAddress>
                ) : (
                  <FingerprintRow>
                    <KeyListAddress title={parsed.fingerprint}>
                      {parsed.fingerprint}
                    </KeyListAddress>
                    <CopyButton
                      value={parsed.fingerprint}
                      label="Copy fingerprint"
                    />
                  </FingerprintRow>
                )}
              </KeyListItemContent>
            </KeyListItem>
          );
        })}
        {!list.length && (
          <KeyListItem>
            <KeyListPlaceholder>No SSH keys.</KeyListPlaceholder>
          </KeyListItem>
        )}
      </KeyList>
    </>
  );
});
