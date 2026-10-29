import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import {setItemAlias} from '../../../../@lib/monoid/index.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {KeyAliasTag} from '../../../@key/key-tags.js';
import {KeyType} from '../../../@key/key-type.js';
import {useMonoidScanPrompt} from '../../../@monoid/monoid-scan-prompt.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
  viewHeaderTagCSS,
} from '../../../@view/index.js';

const AliasTag = styled.button`
  ${viewHeaderTagCSS}
`;

const KEY_ALIAS_MAX_LENGTH = 64;

export const KeyHeader = observer(
  ({data}: {data: WalletKeyData}): ReactNode => {
    const {errorService} = useEntrances();

    const [aliasInput, showAliasInput] = useInputModal();
    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      auth: 'access',
      retryOnError: true,
    });

    const onClick = errorService.catch(async () => {
      const alias = await showAliasInput({
        placeholder: 'Enter key alias',
        defaultValue: data.alias,
        maxLength: KEY_ALIAS_MAX_LENGTH,
        center: true,
      });

      if (alias === undefined || alias === (data.alias ?? '')) {
        return;
      }

      if (alias.length > KEY_ALIAS_MAX_LENGTH) {
        throw new Error(
          `Alias must be ${KEY_ALIAS_MAX_LENGTH} characters or fewer.`,
        );
      }

      await scanPrompt(
        'Scan card to save alias',
        async (applet, setStateContent) => {
          setStateContent('Saving alias, hold tight...');

          await setItemAlias(
            applet,
            data.index,
            alias,
            cause => new Error('Key not found, wrong card?', {cause}),
          );

          runInAction(() => {
            data.alias = alias;
          });
        },
      );
    });

    return (
      <>
        <ViewHeader>
          <ViewHeaderTitle>
            <KeyType type={data.type} />
          </ViewHeaderTitle>
          <ViewHeaderIdentifier
            identifier={{type: 'safe-item', index: data.index}}
            onClick={onClick}
            aria-label="Edit key alias"
          />
          {data.alias && (
            <KeyAliasTag
              as={AliasTag}
              type="button"
              onClick={onClick}
              aria-label="Edit key alias"
            >
              {data.alias}
            </KeyAliasTag>
          )}
        </ViewHeader>
        {aliasInput}
        {scanPromptContent}
      </>
    );
  },
);
