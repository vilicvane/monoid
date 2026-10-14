import {css} from 'styled-components';

export const scrollBorderCSS = css`
  border-color: transparent;
  transition: border-color 0.2s linear;

  &.scrolled {
    border-color: var(--ion-color-light-shade);
  }
`;
