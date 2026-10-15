import type {ReactNode} from 'react';
import {useEffect, useState} from 'react';
import {styled} from 'styled-components';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const DELETE_INTERVAL = 18;
const TYPE_INTERVAL = 30;
const CHANGE_DELAY = 250;

const Fallback = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
`;

const Container = styled.span`
  @media (prefers-reduced-motion: reduce) {
    > [aria-hidden] {
      display: none;
    }

    ${Fallback} {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
      clip-path: none;
    }
  }
`;

export function TypewriterText({
  texts,
  children,
  fallback,
  active = true,
  interval = 3000,
}: {
  texts: readonly [string, string, ...string[]];
  children: (text: string) => ReactNode;
  fallback: ReactNode;
  active?: boolean;
  interval?: number;
}): ReactNode {
  const [{index, length, deleting}, setFrame] = useState({
    index: 0,
    length: 0,
    deleting: false,
  });
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
  const text = texts[index]!;
  const characters = Array.from(text);
  const characterCount = characters.length;
  const textCount = texts.length;

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = (): void => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!active || reducedMotion) {
      return;
    }

    const delay = deleting
      ? length === 0
        ? CHANGE_DELAY
        : DELETE_INTERVAL
      : length === characterCount
        ? interval
        : TYPE_INTERVAL;
    const timer = window.setTimeout(() => {
      if (deleting) {
        setFrame(
          length === 0
            ? {index: (index + 1) % textCount, length: 0, deleting: false}
            : {index, length: length - 1, deleting: true},
        );
      } else {
        setFrame(
          length === characterCount
            ? {index, length, deleting: true}
            : {index, length: length + 1, deleting: false},
        );
      }
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    active,
    reducedMotion,
    index,
    length,
    deleting,
    characterCount,
    textCount,
    interval,
  ]);

  return (
    <Container>
      <Fallback>{fallback}</Fallback>
      <span aria-hidden>{children(characters.slice(0, length).join(''))}</span>
    </Container>
  );
}
