import {css, keyframes} from 'styled-components';

const fadeInKeyFrames = keyframes`
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
`;

export const fadeInAnimationCSS = css`
  animation: ${fadeInKeyFrames} forwards 0.2s linear;
`;

const fadeOutKeyFrames = keyframes`
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
`;

export const fadeOutAnimationCSS = css`
  animation: ${fadeOutKeyFrames} forwards 0.2s linear;
`;

const slideInKeyFrames = keyframes`
  from {
    transform: translateX(var(--slide-offset, 100%));
  }

  to {
    transform: translateX(0);
  }
`;

export const slideInAnimationCSS = css`
  animation: ${slideInKeyFrames} forwards 0.28s
    cubic-bezier(0.22, 0.61, 0.36, 1);
`;

const slideOutKeyFrames = keyframes`
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(var(--slide-offset, 100%));
  }
`;

export const slideOutAnimationCSS = css`
  animation: ${slideOutKeyFrames} forwards 0.28s
    cubic-bezier(0.22, 0.61, 0.36, 1);
`;
const scaleInKeyFrames = keyframes`
  from {
    transform: scale(0.5);
    opacity: 0;
  }

  to {
    transform: scale(1);
    opacity: 1;
  }
`;

export const scaleInAnimationCSS = css`
  animation: ${scaleInKeyFrames} forwards 0.1s ease-in-out;
`;

const scaleOutKeyFrames = keyframes`
  from {
    transform: scale(1);
    opacity: 1;
  }

  to {
    transform: scale(0.5);
    opacity: 0;
  }
`;

export const scaleOutAnimationCSS = css`
  animation: ${scaleOutKeyFrames} forwards 0.1s ease-in-out;
`;

export const popInAnimation = {
  keyframes: [
    {transform: 'scale(0)', opacity: 0},
    {transform: 'scale(1)', opacity: 1},
  ],
  timing: {
    duration: 320,
    easing: 'cubic-bezier(0.2, 1.25, 0.35, 1)',
    fill: 'backwards',
  } satisfies KeyframeAnimationOptions,
  stagger: 60,
};

const popInKeyFrames = keyframes({
  from: popInAnimation.keyframes[0],
  to: popInAnimation.keyframes[1],
});

export const popInAnimationCSS = css`
  animation: ${popInKeyFrames} ${popInAnimation.timing.duration}ms
    ${popInAnimation.timing.easing} both;
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

const collapseOutKeyFrames = keyframes`
  from { transform: scale(1); }
  to { transform: scale(0); }
`;

export const collapseOutAnimationCSS = css`
  animation: ${collapseOutKeyFrames} forwards 240ms
    cubic-bezier(0.22, 1, 0.36, 1);
`;

const breathKeyFrames = keyframes`
  0% {
    opacity: 1;
  }

  25% {
    opacity: 0.5;
  }

  100% {
    opacity: 1;
  }
`;

export const breathAnimationCSS = css`
  animation: ${breathKeyFrames} forwards 2s linear infinite;
`;
