import type {LucideIcon, LucideProps} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

function Icon({
  icon: Component,
  title,
  children,
  ...props
}: LucideProps & {icon: LucideIcon; title?: string}): ReactNode {
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
`;
