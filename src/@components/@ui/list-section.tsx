import {styled} from 'styled-components';

import {NumberBadge} from './number-badge.js';

export const ListSectionCount = styled(NumberBadge)`
  --number-badge-size: 20px;
  --number-badge-font-size: 12px;
  margin-right: var(--tag-inline-margin);
`;
