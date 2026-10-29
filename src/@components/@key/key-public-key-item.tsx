import type {ReactNode} from 'react';

import {InteractiveAddress} from '../@ui/interactive-address.js';

import {KeyListAddress, KeyListItem, KeyListItemContent} from './key-list.js';
import {KeyParameterTag, KeyTags, KeyTypeTag} from './key-tags.js';

export function KeyPublicKeyTags({
  curve,
  context,
}: {
  curve: string;
  context?: string;
}): ReactNode {
  return (
    <>
      <KeyTypeTag>{curve}</KeyTypeTag>
      {context !== undefined && context !== '' && (
        <KeyParameterTag title={context} aria-label={`Context: ${context}`}>
          {context}
        </KeyParameterTag>
      )}
    </>
  );
}

export function KeyPublicKeyItem({
  curve,
  publicKey,
  context,
  copyable = true,
}: {
  curve: string;
  publicKey: string;
  context?: string;
  copyable?: boolean;
}): ReactNode {
  return (
    <KeyListItem>
      <KeyListItemContent>
        <KeyTags>
          <KeyPublicKeyTags curve={curve} context={context} />
        </KeyTags>
        <KeyListAddress
          as={InteractiveAddress}
          title={publicKey}
          copyable={copyable}
          copyLabel="Copy public key"
        >
          {publicKey}
        </KeyListAddress>
      </KeyListItemContent>
    </KeyListItem>
  );
}
