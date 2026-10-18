import {useMemo} from 'react';
import type {ViewEntry__} from 'routra';

/** Track a single route view without reading its proxy after removal. */
export function useViewActive(
  view: ViewEntry__,
  {allowEntering = false}: {allowEntering?: boolean} = {},
): () => boolean {
  return useMemo(() => {
    const route = view.$match;
    const source = route.$view();

    return () =>
      source.$entries.includes(view) &&
      (route.$exact.$active || (allowEntering && route.$exact.$transition)) &&
      !view.$leaving;
  }, [view, allowEntering]);
}
