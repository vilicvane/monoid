import {css, keyframes} from 'styled-components';

const popInKeyFrames = keyframes`
  from {
    transform: scale(0.5);
    opacity: 0;
  }

  to {
    transform: scale(1);
    opacity: 1;
  }
`;

export const popInAnimationCSS = css`
  animation: ${popInKeyFrames} forwards 0.25s cubic-bezier(0, 1.2, 1, 1.2);
`;

const popOutKeyFrames = keyframes`
  from {
    transform: scale(1);
    opacity: 1;
  }

  to {
    transform: scale(0.5);
    opacity: 0;
  }
`;

export const popOutAnimationCSS = css`
  animation: ${popOutKeyFrames} forwards 0.2s cubic-bezier(1, 0.4, 1, 0.4);
`;
