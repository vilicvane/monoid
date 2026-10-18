import type {LucideIcon} from 'lucide-react';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Ionic overlays accept SVG strings rather than React elements.
export function renderIcon(icon: LucideIcon): string {
  const svg = renderToStaticMarkup(
    createElement(icon, {
      nonScalingStroke: true,
      style: {strokeWidth: 'var(--icon-stroke-width, 2)'},
    }),
  );
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
