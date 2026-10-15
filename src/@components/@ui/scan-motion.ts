export const SCAN_REVEAL_DURATION = 480;
export const SCAN_REVEAL_CURVE = [0.22, 1, 0.36, 1] as const;
export const SCAN_REVEAL_EASING = `cubic-bezier(${SCAN_REVEAL_CURVE.join(', ')})`;

export function animateScanFeedback(element: HTMLElement): Animation {
  return element.animate(
    [
      {transform: 'scale(1)'},
      {transform: 'scale(1.04)', offset: 0.35},
      {transform: 'scale(1)'},
    ],
    {duration: 300, easing: 'ease-out'},
  );
}
