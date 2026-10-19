import type {LucideIcon, LucideProps} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

export type AppIconSource = LucideIcon | string;

function Icon({
  icon: Component,
  title,
  children,
  ...props
}: LucideProps & {icon: AppIconSource; title?: string}): ReactNode {
  if (typeof Component === 'string') {
    return (
      <svg width="1em" height="1em" viewBox="0 0 24 24" {...props}>
        {title && <title>{title}</title>}
        <g dangerouslySetInnerHTML={{__html: Component}} />
        {children}
      </svg>
    );
  }

  return (
    <Component size="1em" nonScalingStroke {...props}>
      {title && <title>{title}</title>}
      {children}
    </Component>
  );
}

export const AppIcon = styled(Icon)`
  display: inline-block;
  width: 1em;
  height: 1em;
  box-sizing: content-box;
  stroke-width: var(--icon-stroke-width, 2);

  /* Bundled monochrome SVGs inherit the same color as Lucide icons. */
  > g > svg [fill]:not([fill='none']) {
    fill: currentColor;
  }
`;
