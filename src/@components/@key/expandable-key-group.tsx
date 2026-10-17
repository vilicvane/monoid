import {observer} from 'mobx-react-lite';
import {
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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

const KeyGroupItemContainer = styled(KeyListItem)<{$revealing?: boolean}>`
  &:is(button, [role='button']) {
    box-sizing: border-box;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;

    &:disabled,
    &[aria-disabled='true'] {
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

export const KeyGroupItem = ({
  onExpand,
  disabled,
  onClick,
  onKeyDown,
  ...props
}: HTMLAttributes<HTMLElement> & {
  $revealing?: boolean;
  onExpand?: () => void;
  disabled?: boolean;
} & (
    | {as?: 'div'; ref?: Ref<HTMLDivElement>}
    | {as: 'label'; ref?: Ref<HTMLLabelElement>}
    | {as: 'button'; ref?: Ref<HTMLButtonElement>}
  )): ReactNode => (
  <KeyGroupItemContainer
    {...props}
    type={props.as === 'button' ? 'button' : undefined}
    disabled={props.as === 'button' ? disabled : undefined}
    role={onExpand ? 'button' : props.role}
    tabIndex={onExpand ? (disabled ? -1 : 0) : props.tabIndex}
    aria-disabled={onExpand && disabled ? true : undefined}
    onClick={(event: MouseEvent<HTMLElement>) => {
      if (!onExpand) {
        onClick?.(event);
        return;
      }

      event.preventDefault();
      if (!disabled) onExpand();
    }}
    onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
      if (
        onExpand &&
        event.target === event.currentTarget &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault();
        if (!disabled && !event.repeat) onExpand();
      } else {
        onKeyDown?.(event);
      }
    }}
  />
);

export const ExpandableKeyGroup = observer(function ExpandableKeyGroup({
  children,
  focusSelector = 'input',
  autoExpand = false,
}: {
  children: (state: {
    expanded: boolean;
    collapsing: boolean;
    revealing: boolean;
    expand: () => void;
    collapse: () => void;
  }) => ReactNode;
  focusSelector?: string;
  autoExpand?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const requestedExpanded = useRef(autoExpand);
  const renderedExpanded = useRef(autoExpand);
  const previousAutoExpand = useRef(autoExpand);
  const restoreCollapsedFocus = useRef(false);
  const transitionVersion = useRef(0);
  const pendingTransition = useRef<{
    version: number;
    height: number;
    primaryTop: number;
    transferFocus: boolean;
    rows: Map<Element, {top: number; opacity: string; transform: string}>;
  }>(undefined);
  const [frame, setFrame] = useState({expanded: autoExpand, animating: false});

  const changeExpanded = useCallback(
    (nextExpanded: boolean): void => {
      if (requestedExpanded.current === nextExpanded) return;

      const group = ref.current!;
      const bounds = group.getBoundingClientRect();
      const target = group.querySelector<HTMLElement>(focusSelector);
      const rows = Array.from(group.children, row => {
        const style = getComputedStyle(row);
        return [
          row,
          {
            top: row.getBoundingClientRect().top - bounds.top,
            opacity: style.opacity,
            transform: style.transform,
          },
        ] as const;
      });
      const primary =
        rows.find(([row]) => row === target || row.contains(target)) ?? rows[0];
      pendingTransition.current = {
        version: ++transitionVersion.current,
        height: bounds.height,
        primaryTop: primary?.[1].top ?? 0,
        transferFocus: group.contains(document.activeElement),
        rows: new Map(rows),
      };
      // Keep layout stable while React prepares the rows for this transition.
      group.style.height = `${bounds.height}px`;
      requestedExpanded.current = nextExpanded;
      setFrame({
        // Exit rows stay mounted until the collapse animation finishes.
        expanded: nextExpanded || renderedExpanded.current,
        animating: true,
      });
    },
    [focusSelector],
  );

  useLayoutEffect(() => {
    const shouldExpand = autoExpand && !previousAutoExpand.current;
    previousAutoExpand.current = autoExpand;
    if (shouldExpand) changeExpanded(true);
  }, [autoExpand, changeExpanded]);

  useLayoutEffect(() => {
    renderedExpanded.current = frame.expanded;
    const group = ref.current!;
    const target = group.querySelector<HTMLElement>(focusSelector);
    if (!frame.animating) {
      group.style.height = '';
      if (restoreCollapsedFocus.current) {
        restoreCollapsedFocus.current = false;
        (
          target?.querySelector<HTMLElement>(
            ':is(button, [role="button"]):not(:disabled):not([aria-disabled="true"]):not([inert] *)',
          ) ?? target
        )?.focus({preventScroll: true});
      }
      return;
    }

    const transition = pendingTransition.current;
    pendingTransition.current = undefined;
    if (!transition) {
      restoreCollapsedFocus.current =
        !requestedExpanded.current && group.contains(document.activeElement);
      setFrame({expanded: requestedExpanded.current, animating: false});
      return;
    }
    const expanding = requestedExpanded.current;
    const rows = Array.from(group.children) as HTMLElement[];
    const primary =
      rows.find(row => row === target || row.contains(target)) ?? rows[0];
    const groupTop = group.getBoundingClientRect().top;
    const primaryTop = primary
      ? primary.getBoundingClientRect().top - groupTop
      : 0;
    const height = expanding
      ? rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
      : (primary?.getBoundingClientRect().height ?? 0);
    if (transition.transferFocus) target?.focus({preventScroll: true});

    const finish = (): void => {
      if (transition.version !== transitionVersion.current) return;
      group.style.height = `${height}px`;
      restoreCollapsedFocus.current =
        !expanding && group.contains(document.activeElement);
      setFrame({expanded: expanding, animating: false});
    };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches) {
      finish();
      return;
    }

    const timing = {
      duration: SCAN_REVEAL_DURATION,
      easing: SCAN_REVEAL_EASING,
      fill: 'forwards' as const,
    };
    const animation = group.animate(
      [{height: `${transition.height}px`}, {height: `${height}px`}],
      timing,
    );
    const rowAnimations = rows.map(row => {
      const previous = transition.rows.get(row);
      if (row === primary) {
        return row.animate(
          [
            {
              transform: `translateY(${
                (previous?.top ?? transition.primaryTop) - primaryTop
              }px)`,
            },
            {transform: `translateY(${expanding ? 0 : -primaryTop}px)`},
          ],
          timing,
        );
      }
      return row.animate(
        [
          {
            opacity: previous?.opacity ?? '0',
            transform: previous?.transform ?? 'translateY(-4px)',
          },
          {
            opacity: expanding ? '1' : '0',
            transform: expanding ? 'translateY(0)' : 'translateY(-4px)',
          },
        ],
        timing,
      );
    });
    const exiting = expanding ? [] : rows.filter(row => row !== primary);
    for (const row of exiting) row.inert = true;
    animation.addEventListener('finish', finish);
    const onMotionChange = (): void => {
      if (reducedMotion.matches) {
        animation.finish();
        for (const motion of rowAnimations) motion.finish();
      }
    };
    reducedMotion.addEventListener('change', onMotionChange);

    return () => {
      animation.removeEventListener('finish', finish);
      animation.cancel();
      for (const motion of rowAnimations) motion.cancel();
      for (const row of exiting) row.inert = false;
      reducedMotion.removeEventListener('change', onMotionChange);
    };
  }, [frame, focusSelector]);

  return (
    <Group ref={ref}>
      {children({
        expanded: frame.expanded,
        collapsing: frame.animating && !requestedExpanded.current,
        revealing: frame.animating && requestedExpanded.current,
        expand: () => changeExpanded(true),
        collapse: () => changeExpanded(false),
      })}
    </Group>
  );
});
