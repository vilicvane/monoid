import {styled} from 'styled-components';

export const Tag = styled.div`
  flex-shrink: 0;
  margin: 0 -2px;

  height: 22px;
  padding: 0 6px;
  font-size: 13px;
  border-radius: 12px;

  background-color: var(--ion-color-light);
  border: solid 0.5px var(--ion-color-light-shade);
  color: var(--ion-color-medium-shade);

  display: flex;
  align-items: center;
  justify-content: center;
`;
