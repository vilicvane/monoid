export const SCAN_REVEAL_DURATION = 480;
export const SCAN_REVEAL_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

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
