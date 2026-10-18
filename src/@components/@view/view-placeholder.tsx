import type {HTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import {InfoSectionItemLabel} from '../@ui/info-section.js';
import {LoadingSpinner} from '../@ui/loading-spinner.js';

export const ViewPlaceholder = styled(InfoSectionItemLabel)`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
`;

const Spinner = styled(LoadingSpinner)`
  width: 32px;
  height: 32px;
`;

export const ViewLoading = (
  props: HTMLAttributes<HTMLDivElement>,
): ReactNode => (
  <ViewPlaceholder role="status" aria-label="Loading" {...props}>
    <Spinner />
  </ViewPlaceholder>
);
