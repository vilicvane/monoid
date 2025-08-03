import {styled} from 'styled-components';

export const Input = styled.input`
  border: solid 0.5px var(--ion-color-light-shade);
  box-sizing: content-box;
  height: 20px;
  padding: 8px 12px;
  align-self: stretch;

  border-radius: 4px;
  outline-color: var(--ion-color-primary);

  transition: color 0.2s linear;

  &:not(:focus) {
    color: var(--color-text-secondary);
  }
`;
