import {IonSpinner} from '@ionic/react';
import {styled} from 'styled-components';

export const LoadingSpinner = styled(IonSpinner).attrs({
  name: 'crescent',
  'aria-hidden': true,
})`
  width: 1em;
  height: 1em;
  pointer-events: none;
`;
