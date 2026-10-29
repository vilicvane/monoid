import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {MonoidIdHex} from '../../@atomics.js';
import {KeyAliasTag} from '../@key/key-tags.js';
import {
  ViewHeaderIdentifier,
  ViewHeaderTags,
  viewHeaderTagCSS,
} from '../@view/index.js';

const AliasTag = styled(KeyAliasTag)`
  ${viewHeaderTagCSS}
`;

/**
 * The scanned card's ID and alias, joined like the Card page header (read
 * only, without the bundle).
 */
export function CardHeaderTags({
  card: {id, alias},
}: {
  card: {id: MonoidIdHex; alias?: string | false};
}): ReactNode {
  return (
    <ViewHeaderTags>
      <ViewHeaderIdentifier identifier={{type: 'card', id}} />
      {alias && <AliasTag>{alias}</AliasTag>}
    </ViewHeaderTags>
  );
}
