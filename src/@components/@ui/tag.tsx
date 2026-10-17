import {styled} from 'styled-components';

export const TAG_HEIGHT = 22;

export const Tag = styled.div`
  flex-shrink: 0;
  margin: 0 var(--tag-inline-margin);

  height: ${TAG_HEIGHT}px;
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

export const PrimaryTag = styled(Tag)`
  background-color: var(--ion-color-primary);
  border-color: var(--ion-color-primary-shade);
  color: var(--ion-color-primary-contrast);
`;

export const WhiteTag = styled(Tag)`
  background-color: white;
`;

export const BlackTag = styled(Tag)`
  background-color: black;
  border-color: black;
  color: white;
`;
