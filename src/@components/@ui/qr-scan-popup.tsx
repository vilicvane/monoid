import {App} from '@capacitor/app';
import {Capacitor, type PluginListenerHandle} from '@capacitor/core';
import {
  QrScanner,
  type QrScannerError,
  type QrScannerPreviewBounds,
} from 'capacitor-qr-scanner';
import {type ReactNode, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {QrScanForeground, qrScanLifecycle} from '../../@lib/qr-scanner.js';

import {Button} from './button.js';
import {CenteredPopup} from './centered-popup.js';
import {QrScanPreview, type QrScanPreviewPhase} from './qr-scan-preview.js';
import {SCAN_REVEAL_CURVE} from './scan-motion.js';

const Screen = styled.div`
  position: fixed;
  inset: 0;
  z-index: calc(var(--popup-z-index) + 1);
  background: var(--ion-color-primary-contrast);
  pointer-events: none;
`;

const Popup = styled(CenteredPopup)`
  --ion-color-neutral: var(--ion-color-primary-contrast);
  --ion-color-neutral-contrast: #444444;
  --ion-color-neutral-shade: var(--ion-color-medium-tint);
  --color-text-secondary: #666666;

  color: var(--color-text-secondary);
  gap: 12px;
`;

const Preview = styled.div<{$open: boolean}>`
  --scan-preview-size: min(
    316px,
    max(100px, calc(100dvh - 208px)),
    calc(100vw - var(--view-inset-left) - var(--view-inset-right) - 52px)
  );

  position: relative;
  align-self: center;
  width: var(--scan-preview-size);
  aspect-ratio: 1;
  overflow: clip;
  overflow-clip-margin: 1px;
  background: ${props =>
    props.$open ? 'transparent' : 'var(--ion-color-primary-contrast)'};
`;

const Message = styled.p`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 24px;
  line-height: 1.4;
  color: var(--color-text-secondary);
  text-align: center;
`;

const Controls = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const ValidationMessage = styled.p`
  margin: 0;
  line-height: 1.4;
  color: var(--color-text-secondary);
  text-align: center;
`;

type ScanStatus =
  | 'starting'
  | 'scanning'
  | 'completing'
  | 'paused'
  | 'denied'
  | 'unsupported'
  | 'error';

const STATUS_TEXT: Partial<Record<ScanStatus, string>> = {
  paused: 'Scanning paused',
  denied: 'Allow camera access to scan',
  unsupported: 'Camera scanning is unavailable here',
  error: 'Could not scan. Please try again.',
};

/** Let the native preview show through without unmounting the caller's form. */
function openCameraAperture(
  preview: HTMLElement,
  popup: HTMLElement,
  backdrop: HTMLElement,
  screen: HTMLElement,
): {update: () => void; restore: () => void} {
  const restores: (() => void)[] = [];
  const set = (element: HTMLElement, property: string, value: string): void => {
    const previous = element.style.getPropertyValue(property);
    const priority = element.style.getPropertyPriority(property);
    restores.push(() => {
      if (previous) element.style.setProperty(property, previous, priority);
      else element.style.removeProperty(property);
    });
    element.style.setProperty(property, value);
  };

  let child: HTMLElement = popup;
  while (child.parentElement) {
    const parent = child.parentElement;
    for (const sibling of parent.children) {
      if (sibling !== child && sibling instanceof HTMLElement) {
        set(sibling, 'visibility', 'hidden');
      }
    }
    set(parent, 'background-color', 'transparent');
    if (parent === document.body) break;
    child = parent;
  }
  for (const sibling of popup.children) {
    if (
      sibling instanceof HTMLElement &&
      sibling !== backdrop &&
      sibling !== screen &&
      !sibling.contains(preview)
    ) {
      set(sibling, 'visibility', 'hidden');
    }
  }

  // Only the preview can reveal the native camera through the opaque screen.
  set(screen, 'clip-path', 'none');
  const update = (): void => {
    const bounds = preview.getBoundingClientRect();
    const origin = screen.getBoundingClientRect();
    const left = bounds.left - origin.left;
    const top = bounds.top - origin.top;
    const right = left + bounds.width;
    const bottom = top + bounds.height;
    screen.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`;
  };
  update();

  return {
    update,
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

export function QrScanPopup({
  validate,
  onScan,
  onDismiss,
}: {
  validate?: (value: string) => string | undefined;
  onScan: (value: string) => void;
  onDismiss: () => void;
}): ReactNode {
  const {errorService, portals} = useEntrances();
  const previewRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({validate, onScan, onDismiss});
  const revealRef = useRef<(duration: number) => Promise<boolean>>(undefined);
  const completeRef = useRef<() => void>(undefined);
  const dismissRef = useRef<() => void>(undefined);
  const foregroundRef = useRef<QrScanForeground>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ScanStatus>('starting');
  const [settledPhase, setSettledPhase] = useState<QrScanPreviewPhase>();
  const [validationError, setValidationError] = useState<string>();
  const [closing, setClosing] = useState(false);

  useLayoutEffect(() => {
    const backdrop = portals.popupBackdrop.element;
    const visibility = backdrop.style.getPropertyValue('visibility');
    const priority = backdrop.style.getPropertyPriority('visibility');
    backdrop.style.setProperty('visibility', 'hidden');
    return () => {
      if (visibility)
        backdrop.style.setProperty('visibility', visibility, priority);
      else backdrop.style.removeProperty('visibility');
    };
  }, [portals]);

  useLayoutEffect(() => {
    callbacks.current = {validate, onScan, onDismiss};
  });

  useLayoutEffect(() => {
    if (
      Capacitor.getPlatform() === 'web' ||
      !Capacitor.isPluginAvailable('QrScanner')
    )
      return;

    const foreground = new QrScanForeground(error => {
      errorService.catch(Promise.reject(error));
    });
    foregroundRef.current = foreground;
    return () => {
      foreground.dispose();
      foregroundRef.current = undefined;
    };
  }, [errorService]);

  useLayoutEffect(() => {
    setStatus('starting');
    setSettledPhase(undefined);
    setValidationError(undefined);
    setClosing(false);

    if (
      Capacitor.getPlatform() === 'web' ||
      !Capacitor.isPluginAvailable('QrScanner')
    ) {
      setStatus('unsupported');
      dismissRef.current = () => callbacks.current.onDismiss();
      return () => {
        dismissRef.current = undefined;
      };
    }

    const scanId = Array.from(
      crypto.getRandomValues(new Uint32Array(4)),
      value => value.toString(16),
    ).join('-');
    const listeners: PluginListenerHandle[] = [];
    let disposed = false;
    let finished = false;
    let dismissing = false;
    let paused = false;
    let started = false;
    let awaitingScanEnd = false;
    let cancelResume: (() => void) | undefined;
    let accepted: string | undefined;
    let stopped: Promise<void> | undefined;
    let aperture: ReturnType<typeof openCameraAperture> | undefined;
    let frame: number | undefined;
    let resolveCovered!: () => void;
    const covered = new Promise<void>(resolve => {
      resolveCovered = resolve;
    });

    const restore = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      aperture?.restore();
      aperture = undefined;
    };
    const stop = (): Promise<void> => {
      if (!stopped) {
        stopped = QrScanner.stopScan({scanId})
          .catch(error => {
            stopped = undefined;
            throw error;
          })
          .finally(restore);
        qrScanLifecycle.closing = Promise.all([
          qrScanLifecycle.closing,
          stopped.catch(() => undefined),
        ]).then(() => undefined);
      }
      return stopped;
    };
    const pause = (resumeOnForeground = true): void => {
      if (disposed || paused) return;
      const resumable = !finished && !dismissing && accepted === undefined;
      paused = true;
      finished = true;
      const stopping = stop();
      errorService.catch(stopping.finally(resolveCovered));
      if (!resumable) {
        if (accepted !== undefined && !dismissing) {
          setValidationError(undefined);
          setStatus('paused');
        }
        return;
      }

      setValidationError(undefined);
      setStatus('paused');
      if (!resumeOnForeground) return;
      cancelResume = foregroundRef.current?.requestResume(
        stopping,
        () => !disposed && paused && !dismissing && accepted === undefined,
        () => setAttempt(value => value + 1),
      );
    };
    const fail = (error: unknown, fromNativeEnd = false): void => {
      if (disposed || finished) return;
      const {code} = error as QrScannerError;
      // Preview updates can observe native teardown before its scanEnded event.
      // That event determines whether this is a recoverable pause or a failure.
      if (code === 'SCAN_CLOSED' && !fromNativeEnd) {
        awaitingScanEnd = true;
        return;
      }
      if (code === 'CANCELLED' || code === 'APP_INACTIVE') {
        pause();
        return;
      }
      finished = true;
      accepted = undefined;
      setValidationError(undefined);
      setStatus(
        code === 'PERMISSION_DENIED'
          ? 'denied'
          : code === 'NO_CAMERA' || code === 'UNSUPPORTED'
            ? 'unsupported'
            : 'error',
      );
      if (
        code !== 'NO_CAMERA' &&
        code !== 'UNSUPPORTED' &&
        code !== 'PERMISSION_DENIED'
      ) {
        errorService.catch(Promise.reject(error));
      }
      errorService.catch(stop());
    };
    const measure = (): QrScannerPreviewBounds => {
      const {x, y, width, height} = previewRef.current!.getBoundingClientRect();
      return {
        x: x / window.innerWidth,
        y: y / window.innerHeight,
        width: width / window.innerWidth,
        height: height / window.innerHeight,
      };
    };
    let previousBounds = '';
    const trackBounds = (): void => {
      if (disposed || finished || awaitingScanEnd || !started) return;
      const previewBounds = measure();
      const serialized = JSON.stringify(previewBounds);
      if (previousBounds !== serialized) {
        previousBounds = serialized;
        aperture?.update();
        void QrScanner.updatePreviewBounds({scanId, previewBounds}).catch(fail);
      }
      // Popup entry motion and scrolling can move the preview without resizing it.
      frame = requestAnimationFrame(trackBounds);
    };

    dismissRef.current = () => {
      if (disposed || dismissing) return;
      dismissing = true;
      finished = true;
      cancelResume?.();
      accepted = undefined;
      setClosing(true);
      const cover = aperture ? covered : Promise.resolve();
      if (aperture) setStatus('completing');
      errorService.catch(
        cover
          .then(() => (disposed ? undefined : stop()))
          .then(() => {
            if (!disposed) callbacks.current.onDismiss();
          })
          .catch(error => {
            if (!disposed) {
              dismissing = false;
              setClosing(false);
              setStatus('error');
            }
            throw error;
          }),
      );
    };
    completeRef.current = () => {
      resolveCovered();
      if (disposed || finished || accepted === undefined) return;
      finished = true;
      const value = accepted;
      errorService.catch(
        stop()
          .then(() => {
            if (!disposed && !dismissing && !paused && !document.hidden) {
              callbacks.current.onScan(value);
            }
          })
          .catch(error => {
            if (!disposed) setStatus('error');
            throw error;
          }),
      );
    };
    const visibilityChanged = (): void => {
      if (document.hidden) pause();
    };

    void (async () => {
      await qrScanLifecycle.closing;
      if (disposed || finished) return;
      if (document.hidden) {
        pause();
        return;
      }

      let permissions = await QrScanner.checkPermissions();
      if (disposed || finished) return;
      if (permissions.camera !== 'granted' || attempt > 0) {
        permissions = await QrScanner.requestPermissions();
      }
      if (disposed || finished) return;
      if (permissions.camera !== 'granted') {
        finished = true;
        setStatus('denied');
        return;
      }

      // iOS permission sheets temporarily deactivate the app. Observe pauses
      // after permission returns so accepting the first prompt can start scanning.
      document.addEventListener('visibilitychange', visibilityChanged);
      if (document.hidden) {
        pause();
        return;
      }
      listeners.push(
        await App.addListener('appStateChange', ({isActive}) => {
          if (!isActive) pause();
        }),
      );
      if (disposed || finished) return;

      listeners.push(
        await QrScanner.addListener('codesScanned', event => {
          if (
            event.scanId !== scanId ||
            disposed ||
            finished ||
            awaitingScanEnd ||
            accepted !== undefined
          )
            return;

          let message: string | undefined;
          for (const value of event.values) {
            const error = callbacks.current.validate?.(value);
            if (error !== undefined) {
              message ??= error;
              continue;
            }
            accepted = value;
            setValidationError(undefined);
            setStatus('completing');
            return;
          }
          if (message) setValidationError(message);
        }),
      );
      if (disposed || finished) return;

      listeners.push(
        await QrScanner.addListener('scanEnded', event => {
          if (event.scanId !== scanId || disposed) return;
          if (event.reason === 'app-paused') {
            pause();
            return;
          }
          if (finished) return;
          if (event.reason === 'error') {
            fail(
              Object.assign(new Error(event.message), {code: event.code}),
              true,
            );
          } else {
            pause(false);
          }
        }),
      );
      if (disposed || finished || accepted !== undefined) return;

      // Native preview geometry must not inherit the popup's entrance offset.
      await Promise.all(
        previewRef
          .current!.getAnimations()
          .map(animation => animation.finished),
      );
      if (disposed || finished || accepted !== undefined) return;

      await QrScanner.startScan({scanId, previewBounds: measure()});
      if (disposed || finished || accepted !== undefined) return;
      started = true;
      aperture = openCameraAperture(
        previewRef.current!,
        portals.popup,
        portals.popupBackdrop.element,
        screenRef.current!,
      );
      trackBounds();
      revealRef.current = duration =>
        QrScanner.animatePreview({
          scanId,
          fromScale: attempt > 0 ? 1 : 0.5,
          toScale: 1,
          duration: attempt > 0 ? 0 : duration,
          easing: SCAN_REVEAL_CURVE,
        }).then(
          () => true,
          error => {
            fail(error);
            return false;
          },
        );
      setStatus('scanning');
    })()
      .catch(fail)
      .finally(() => {
        if (disposed) {
          for (const listener of listeners.splice(0)) {
            errorService.catch(listener.remove());
          }
        }
      });

    return () => {
      disposed = true;
      cancelResume?.();
      resolveCovered();
      restore();
      revealRef.current = undefined;
      completeRef.current = undefined;
      dismissRef.current = undefined;
      document.removeEventListener('visibilitychange', visibilityChanged);
      for (const listener of listeners.splice(0)) {
        errorService.catch(listener.remove());
      }
      errorService.catch(stop());
    };
  }, [attempt, errorService, portals]);

  const phase =
    status === 'starting' || status === 'scanning' || status === 'completing'
      ? status
      : 'idle';

  return (
    <>
      {createPortal(
        <Screen ref={screenRef} aria-hidden="true" />,
        portals.popup,
      )}
      <Popup aria-label="Scan QR code" onDismiss={() => dismissRef.current?.()}>
        <Preview
          ref={previewRef}
          $open={status === 'scanning' || status === 'completing'}
          role="group"
          aria-label={
            status === 'scanning' && settledPhase === 'scanning'
              ? 'Camera preview active'
              : 'Camera preview'
          }
        >
          <QrScanPreview
            phase={phase}
            revealMode={attempt > 0 ? 'fade' : 'zoom'}
            showProcessingSpinner={false}
            onReveal={duration =>
              revealRef.current?.(duration) ?? Promise.resolve(false)
            }
            onCovered={() => completeRef.current?.()}
            onSettled={setSettledPhase}
          />
          {settledPhase === 'idle' && STATUS_TEXT[status] && (
            <Message role="status" aria-live="polite">
              {STATUS_TEXT[status]}
            </Message>
          )}
        </Preview>
        <Controls>
          {validationError && (
            <ValidationMessage role="status">
              {validationError}
            </ValidationMessage>
          )}
          {(status === 'error' ||
            status === 'denied' ||
            status === 'paused') && (
            <Button
              disabled={closing}
              onClick={() => setAttempt(value => value + 1)}
            >
              {status === 'paused' ? 'Resume' : 'Try again'}
            </Button>
          )}
        </Controls>
      </Popup>
    </>
  );
}
