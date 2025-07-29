import {useEffect, useState} from 'react';

export function useTemporaryState<T>(
  defaultState: (() => T) | T,
  duration: number,
): [T, (value: T) => void] {
  const [state, setState] = useState<T>(defaultState);

  useEffect(() => {
    if (state === defaultState) {
      return;
    }

    const timer = setTimeout(() => setState(defaultState), duration);

    return () => clearTimeout(timer);
  }, [defaultState, duration, state]);

  return [state, setState];
}
