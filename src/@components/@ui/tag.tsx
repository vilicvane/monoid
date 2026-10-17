import {css, styled} from 'styled-components';

export const TAG_HEIGHT = 22;

export const darkTagCSS = css`
  background-color: var(--ion-color-dark);
  border-color: var(--ion-color-dark-shade);
  color: var(--ion-color-dark-contrast);
`;

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

export const WarningTag = styled(Tag)`
  background-color: var(--ion-color-warning);
  border-color: var(--ion-color-warning-shade);
  color: var(--ion-color-warning-contrast);
`;

export const WhiteTag = styled(Tag)`
  background-color: var(--color-address-tag-background, white);
  border-color: var(--color-address-tag-border, var(--ion-color-light-shade));
  color: var(--color-address-tag-text, var(--ion-color-medium-shade));
`;

export const BlackTag = styled(Tag)`
  background-color: black;
  border-color: black;
  color: white;
`;
