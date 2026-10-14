import {observer} from 'mobx-react-lite';
import {type ReactNode, useLayoutEffect, useRef, useState} from 'react';
import {css, keyframes, styled} from 'styled-components';

import {SCAN_REVEAL_DURATION, SCAN_REVEAL_EASING} from '../@ui/scan-motion.js';

import {KeyListItem} from './key-list.js';

const Group = styled.div`
  overflow: hidden;
`;

const reveal = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

export const keyGroupReveal = css<{$revealing?: boolean}>`
  ${({$revealing}) =>
    $revealing &&
    css`
      animation: ${reveal} ${SCAN_REVEAL_DURATION}ms ${SCAN_REVEAL_EASING};
    `}

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export const KeyGroupItem = styled(KeyListItem)<{$revealing?: boolean}>`
  &[type='button'] {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }

    &:focus-visible {
      outline: 2px solid var(--ion-color-primary);
      outline-offset: -2px;
    }
  }

  ${keyGroupReveal}
`;

export const ExpandableKeyGroup = observer(function ExpandableKeyGroup({
  children,
  focusSelector = 'input',
  autoExpand = false,
}: {
  children: (state: {
    expanded: boolean;
    revealing: boolean;
    expand: () => void;
  }) => ReactNode;
  focusSelector?: string;
  autoExpand?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const previousHeight = useRef<number>(undefined);
  const previousTargetTop = useRef<number>(undefined);
  const focusAfterExpand = useRef(false);
  const [expanded, setExpanded] = useState(autoExpand);
  const [revealing, setRevealing] = useState(false);

  useLayoutEffect(() => {
    if (autoExpand && !expanded) {
      focusAfterExpand.current = ref.current!.contains(document.activeElement);
      setExpanded(true);
    }
  }, [autoExpand, expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;

    const group = ref.current!;
    if (focusAfterExpand.current) {
      group
        .querySelector<HTMLElement>(focusSelector)
        ?.focus({preventScroll: true});
    }

    if (previousHeight.current === undefined) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) {
      setRevealing(false);
      return;
    }

    const groupBounds = group.getBoundingClientRect();
    const target = group.querySelector<HTMLElement>(focusSelector);
    const offset =
      target && previousTargetTop.current !== undefined
        ? previousTargetTop.current -
          (target.getBoundingClientRect().top - groupBounds.top)
        : 0;
    const timing = {
      duration: SCAN_REVEAL_DURATION,
      easing: SCAN_REVEAL_EASING,
    };
    const animation = group.animate(
      [
        {height: `${previousHeight.current}px`},
        {height: `${groupBounds.height}px`},
      ],
      timing,
    );
    const positionAnimation =
      target && offset !== 0
        ? target.animate(
            [
              {transform: `translateY(${offset}px)`},
              {transform: 'translateY(0)'},
            ],
            timing,
          )
        : undefined;
    const onFinish = (): void => setRevealing(false);
    animation.addEventListener('finish', onFinish);
    const onMotionChange = (): void => {
      if (reducedMotion.matches) {
        animation.finish();
        positionAnimation?.finish();
        setRevealing(false);
      }
    };
    reducedMotion.addEventListener('change', onMotionChange);

    return () => {
      animation.removeEventListener('finish', onFinish);
      animation.cancel();
      positionAnimation?.cancel();
      reducedMotion.removeEventListener('change', onMotionChange);
    };
  }, [expanded, focusSelector]);

  const expand = (): void => {
    if (expanded) return;

    const group = ref.current!;
    const groupBounds = group.getBoundingClientRect();
    const target = group.querySelector<HTMLElement>(focusSelector);

    previousHeight.current = groupBounds.height;
    previousTargetTop.current = target
      ? target.getBoundingClientRect().top - groupBounds.top
      : undefined;
    focusAfterExpand.current = group.contains(document.activeElement);
    setRevealing(true);
    setExpanded(true);
  };

  return <Group ref={ref}>{children({expanded, revealing, expand})}</Group>;
});
