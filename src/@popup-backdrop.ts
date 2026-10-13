export class PopupBackdropController {
  element = document.createElement('div');

  private owners = new Set<symbol>();
  private animation: Animation | undefined;
  private completion = Promise.resolve();
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor() {
    this.element.className = 'popup-backdrop';

    this.reducedMotion.addEventListener('change', () => {
      if (this.reducedMotion.matches) {
        this.animation?.finish();
      }
    });
  }

  acquire(owner: symbol): Promise<void> {
    if (this.owners.has(owner)) {
      return this.completion;
    }

    this.owners.add(owner);

    if (this.owners.size === 1) {
      return this.transition(true);
    }

    return this.completion;
  }

  release(owner: symbol): Promise<void> {
    if (!this.owners.delete(owner) || this.owners.size > 0) {
      return Promise.resolve();
    }

    return this.transition(false);
  }

  private transition(visible: boolean): Promise<void> {
    this.animation?.commitStyles();
    this.animation?.cancel();

    this.animation = this.element.animate(
      [
        {opacity: getComputedStyle(this.element).opacity},
        {opacity: visible ? 1 : 0},
      ],
      {
        duration: this.reducedMotion.matches ? 0 : 180,
        easing: visible ? 'ease-out' : 'ease-in',
        fill: 'forwards',
      },
    );
    this.completion = this.animation.finished.then(
      () => {},
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          throw error;
        }
      },
    );

    return this.completion;
  }
}
