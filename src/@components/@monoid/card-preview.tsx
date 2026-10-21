import {styled} from 'styled-components';

import {MonoidCard, MonoidCardFrame} from './monoid-card.js';

export const CardGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 300px;
`;

export const CardPreviewButton = styled.button`
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--ion-color-dark);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 3px;
  }
`;

export const CardPreview = styled(MonoidCard)<{
  $interrupted?: boolean;
  $pending?: boolean;
}>`
  --monoid-card-background: ${props =>
    props.$pending
      ? 'var(--ion-color-light)'
      : 'var(--ion-color-dark-contrast)'};
  --monoid-card-logo-width: calc(72 / 430 * 100%);
  --monoid-card-logo-background: ${props =>
    props.$interrupted
      ? 'var(--ion-color-warning)'
      : 'var(--ion-color-primary)'};
  --monoid-card-description-color: ${props =>
    props.$interrupted
      ? 'var(--color-text-warning)'
      : 'var(--ion-color-primary)'};

  box-sizing: border-box;
  border: 0.5px solid var(--ion-color-medium-tint);
`;

export const CardPlaceholder = styled(MonoidCardFrame)`
  --monoid-card-background: var(--ion-color-light);

  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border: 0.5px solid var(--ion-color-light-shade);
  color: var(--ion-color-light-shade);
  font-size: 24px;
  text-align: center;
`;
