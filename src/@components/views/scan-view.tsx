import {Clipboard} from '@capacitor/clipboard';
import {Capacitor, type PluginListenerHandle} from '@capacitor/core';
import {
  QrScanner,
  type QrScannerError,
  type QrScannerPreviewBounds,
} from 'capacitor-qr-scanner';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {createGlobalStyle, styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {parseOTPURI} from '../../@lib/otp.js';
import {QrScanForeground, qrScanLifecycle} from '../../@lib/qr-scanner.js';
import {parseWalletConnectUri} from '../../@lib/wallet-connect.js';
import type {Router} from '../../@routes.js';
import {Button} from '../@ui/button.js';
import {
  QrScanPreview,
  type QrScanPreviewPhase,
} from '../@ui/qr-scan-preview.js';
import {
  SCAN_REVEAL_CURVE,
  SCAN_REVEAL_DURATION,
  SCAN_REVEAL_EASING,
} from '../@ui/scan-motion.js';
import {useToast} from '../@ui/toast.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

import {QrScanInstructions} from './@scan/qr-scan-instructions.js';

const CameraBackground = createGlobalStyle`
  body {
    background: transparent;
  }
`;

const Container = styled(View)`
  background: transparent;
  overflow: hidden;

  // The incoming page fades over both the WebView and the native camera.
  // Keep the aperture mask opaque until that transition finishes.
  &.animation.leaving {
    animation-timing-function: step-end;
  }
`;

const Header = styled(ViewHeader)`
  background: var(--ion-color-primary-contrast);
`;

const HeaderKeyword = styled(QrScanInstructions)<{$visible: boolean}>`
  grid-column: 2 / -1;
  min-width: 0;
  text-align: right;
  opacity: ${props => (props.$visible ? 1 : 0)};
  transition: opacity 160ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const Content = styled(ViewContent)`
  // Keep this layout above ViewContent defaults even after hot updates.
  && {
    --scan-preview-size: min(
      320px,
      45vh,
      calc(100vw - var(--view-padding) * 2)
    );

    display: grid;
    grid-template-columns: minmax(0, 1fr);
    // Center the camera and its 40px button together, including the 12px gap.
    // Reserve the button row while it is hidden so the camera stays in place.
    grid-template-rows: minmax(0, 1fr) var(--scan-preview-size) 52px minmax(
        0,
        1fr
      );
    justify-items: center;
    gap: 0;
    overflow: hidden;

    @media (max-height: 600px) and (orientation: landscape) {
      --scan-preview-size: min(240px, 40vh, 40vw);

      grid-template-rows: minmax(0, 1fr);
      grid-template-columns: var(--scan-preview-size) minmax(0, 320px);
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
  }
`;

const Preview = styled.div<{$open: boolean}>`
  position: relative;
  grid-row: 2;
  grid-column: 1;
  width: var(--scan-preview-size);
  aspect-ratio: 1;
  // Keep the mask local, with overlap for native/WebView pixel rounding.
  overflow: clip;
  overflow-clip-margin: 1px;
  background: ${props =>
    props.$open ? 'transparent' : 'var(--ion-color-primary-contrast)'};
  transition: background-color
    ${props => (props.$open ? SCAN_REVEAL_DURATION : 0)}ms ${SCAN_REVEAL_EASING};

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  @media (max-height: 600px) and (orientation: landscape) {
    grid-row: 1;
  }
`;

const StatusMessage = styled.p<{$visible: boolean}>`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 24px;
  color: var(--color-text-secondary);
  text-align: center;
  opacity: ${props => (props.$visible ? 1 : 0)};
  pointer-events: none;
  transition: opacity 200ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const Controls = styled.div<{$visible: boolean}>`
  position: relative;
  z-index: 1;
  grid-row: 3;
  align-self: start;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(100%, 320px);
  padding-top: 12px;
  text-align: center;
  max-height: 144px;
  overflow: auto;
  opacity: ${props => (props.$visible ? 1 : 0)};
  transform: translateY(${props => (props.$visible ? '0px' : '-6px')})
    scale(${props => (props.$visible ? 1 : 0.96)});
  transform-origin: center top;
  will-change: opacity, transform;
  pointer-events: ${props => (props.$visible ? 'auto' : 'none')};
  transition:
    opacity 200ms ease-out,
    transform 200ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  @media (max-height: 600px) and (orientation: landscape) {
    grid-row: 1;
    align-self: center;
    padding-top: 0;
  }

  > button {
    flex-shrink: 0;
    margin: 0;
  }
`;

type ScanStatus =
  | 'starting'
  | 'scanning'
  | 'completing'
  | 'scanned'
  | 'paused'
  | 'denied'
  | 'unsupported'
  | 'error';

const STATUS_TEXT: Record<
  Exclude<ScanStatus, 'scanning' | 'completing' | 'scanned'>,
  string
> = {
  starting: 'Opening camera…',
  paused: 'Scanning paused',
  denied: 'Allow camera access to scan',
  unsupported: 'Camera scanning is unavailable here',
  error: 'Could not scan. Please try again.',
};

type ScanLink = {kind: 'wallet-connect' | 'otp'; uri: string};

function parseScanLink(value: string): ScanLink | undefined {
  const uri = value.trim();
  if (/^otpauth:/i.test(uri)) {
    const account = parseOTPURI(uri);
    account.secret.fill(0);
    return {kind: 'otp', uri};
  }
  const walletConnect = parseWalletConnectUri(uri);
  return walletConnect
    ? {kind: 'wallet-connect', uri: walletConnect}
    : undefined;
}

export const ScanView = observer(
  ({view}: RouteComponentProps<Router['scan']>): ReactNode => {
    const {router, walletKitService, otpStore, errorService} = useEntrances();
    const toast = useToast();
    const previewRef = useRef<HTMLDivElement>(null);
    const revealRef = useRef<(duration: number) => Promise<boolean>>(undefined);
    const completeRef = useRef<() => void>(undefined);
    const scannedUriRef = useRef<ScanLink & {consumed: boolean}>(undefined);
    const pasteRef = useRef<AbortController>(undefined);
    const foregroundRef = useRef<QrScanForeground>(undefined);
    const [pasting, setPasting] = useState(false);
    const [scanAttempt, setScanAttempt] = useState({
      number: 0,
      resuming: false,
    });
    const [status, setStatus] = useState<ScanStatus>('starting');
    const [settledPhase, setSettledPhase] = useState<QrScanPreviewPhase>();
    const [controlsPhase, setControlsPhase] = useState<QrScanPreviewPhase>();
    const [connectionResult, setConnectionResult] = useState<
      ({proposalId: number} | {error: unknown}) & {signal: AbortSignal}
    >();
    const connecting = status === 'completing' || status === 'scanned';
    const active = !view.$leaving && view.$match.$exact.$active;
    const cameraVisible =
      active ||
      (!!view.$leaving && (status === 'scanning' || status === 'completing'));

    useEffect(() => {
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

    const acceptUri = useCallback(
      (link: ScanLink): void => {
        if (
          scannedUriRef.current ||
          view.$leaving ||
          !view.$match.$exact.$active
        )
          return;

        // Claim the result synchronously so scanning and pasting cannot handle it twice.
        scannedUriRef.current = {...link, consumed: false};
        setConnectionResult(undefined);
        setSettledPhase(undefined);
        setStatus('completing');
      },
      [view],
    );

    useEffect(() => {
      setPasting(false);

      return () => {
        pasteRef.current?.abort();
        pasteRef.current = undefined;
      };
    }, [active]);

    const paste = async (): Promise<void> => {
      if (!active || connecting || pasteRef.current) return;

      const controller = new AbortController();
      pasteRef.current = controller;
      setPasting(true);

      try {
        const {value, type} = await Clipboard.read();
        if (controller.signal.aborted || scannedUriRef.current) return;

        if (type !== 'text/plain' && type !== 'text/uri-list') {
          toast({
            message: 'Paste a WalletConnect or OTP link.',
          });
        } else if (!value.trim()) {
          toast({message: 'Clipboard is empty.'});
        } else {
          try {
            const link = parseScanLink(value);
            if (link) acceptUri(link);
            else toast({message: 'Paste a WalletConnect or OTP link.'});
          } catch (error) {
            toast({
              message: error instanceof Error ? error.message : 'Invalid link',
            });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !scannedUriRef.current) {
          toast({
            message:
              error instanceof Error &&
              error.message === 'There is no data on the clipboard'
                ? 'Clipboard is empty.'
                : 'Could not read the clipboard. Please try again.',
          });
        }
      } finally {
        if (pasteRef.current === controller) {
          pasteRef.current = undefined;
          setPasting(false);
        }
      }
    };

    useEffect(() => {
      if (!cameraVisible) {
        if (scanAttempt.resuming) {
          setScanAttempt(attempt => ({...attempt, resuming: false}));
        }
        return;
      }

      setStatus('starting');
      setSettledPhase(undefined);
      setConnectionResult(undefined);
      scannedUriRef.current = undefined;

      if (
        Capacitor.getPlatform() === 'web' ||
        !Capacitor.isPluginAvailable('QrScanner')
      ) {
        setStatus('unsupported');
        return;
      }

      const scanId = Array.from(
        crypto.getRandomValues(new Uint32Array(4)),
        value => value.toString(16),
      ).join('-');
      const listeners: PluginListenerHandle[] = [];
      let disposed = false;
      let finished = false;
      let terminal = false;
      let awaitingScanEnd = false;
      let started = false;
      let stopped: Promise<void> | undefined;
      let cancelResume: (() => void) | undefined;
      let lastInvalidMessage: string | undefined;

      const stop = (): Promise<void> =>
        (stopped ??= QrScanner.stopScan({scanId}));
      const canResume = (): boolean =>
        !disposed &&
        !terminal &&
        !scannedUriRef.current &&
        !view.$leaving &&
        view.$match.$exact.$active;
      const pause = (): void => {
        if (!canResume()) return;

        finished = true;
        awaitingScanEnd = false;
        setStatus('paused');
        if (!cancelResume) {
          const ready = stop();
          errorService.catch(ready);
          cancelResume = foregroundRef.current!.requestResume(
            ready,
            canResume,
            () =>
              setScanAttempt(attempt => ({
                number: attempt.number + 1,
                resuming: true,
              })),
          );
        }
      };
      const fail = (error: unknown): void => {
        if (
          !disposed &&
          (!finished || awaitingScanEnd) &&
          !scannedUriRef.current
        ) {
          const {code} = error as QrScannerError;
          if (code === 'CANCELLED' || code === 'APP_INACTIVE') {
            pause();
            return;
          }

          finished = true;
          // A preview update can observe native teardown before scanEnded.
          // Only the eventual app-paused event may authorize automatic resume.
          awaitingScanEnd = code === 'SCAN_CLOSED';
          terminal = !awaitingScanEnd;
          if (awaitingScanEnd) {
            setStatus('paused');
          } else if (code === 'NO_CAMERA' || code === 'UNSUPPORTED') {
            setStatus('unsupported');
          } else if (code === 'PERMISSION_DENIED') {
            setStatus('denied');
          } else {
            setStatus('error');
            errorService.catch(Promise.reject(error));
          }
          errorService.catch(stop());
        }
      };

      const measure = (): QrScannerPreviewBounds => {
        const {x, y, width, height} =
          previewRef.current!.getBoundingClientRect();

        return {
          x: x / window.innerWidth,
          y: y / window.innerHeight,
          width: width / window.innerWidth,
          height: height / window.innerHeight,
        };
      };

      const resize = (): void => {
        if (started && !disposed && !finished) {
          void QrScanner.updatePreviewBounds({
            scanId,
            previewBounds: measure(),
          }).catch(fail);
        }
      };
      const observer = new ResizeObserver(resize);

      completeRef.current = () => {
        completeRef.current = undefined;
        if (disposed) return;

        terminal = true;
        cancelResume?.();
        finished = true;
        // Hide the camera only after the success cover is fully opaque.
        errorService.catch(
          stop().finally(() => {
            if (!disposed) setStatus('scanned');
          }),
        );
      };

      void (async () => {
        await qrScanLifecycle.closing;
        if (disposed || finished || scannedUriRef.current) return;

        let permissions = await QrScanner.checkPermissions();
        if (disposed || finished || scannedUriRef.current) return;

        if (permissions.camera !== 'granted' || scanAttempt.number > 0) {
          permissions = await QrScanner.requestPermissions();
        }
        if (disposed || finished || scannedUriRef.current) return;

        if (permissions.camera !== 'granted') {
          terminal = true;
          finished = true;
          setStatus('denied');
          return;
        }

        listeners.push(
          await QrScanner.addListener('codesScanned', event => {
            if (
              event.scanId !== scanId ||
              disposed ||
              finished ||
              scannedUriRef.current ||
              view.$leaving ||
              !view.$match.$exact.$active
            )
              return;

            let invalidMessage: string | undefined;
            for (const value of event.values) {
              try {
                const link = parseScanLink(value);
                if (link) {
                  acceptUri(link);
                  return;
                }
              } catch (error) {
                invalidMessage =
                  error instanceof Error ? error.message : 'Invalid OTP link';
              }
            }
            if (invalidMessage && invalidMessage !== lastInvalidMessage) {
              lastInvalidMessage = invalidMessage;
              toast({message: invalidMessage});
            }
          }),
        );
        if (disposed || finished || scannedUriRef.current) return;

        listeners.push(
          await QrScanner.addListener('scanEnded', event => {
            if (event.scanId !== scanId || disposed || scannedUriRef.current)
              return;

            if (event.reason === 'app-paused') {
              pause();
              return;
            }
            if (finished && !awaitingScanEnd) return;

            if (event.reason === 'error') {
              fail(Object.assign(new Error(event.message), {code: event.code}));
            } else {
              terminal = true;
              awaitingScanEnd = false;
              finished = true;
              setStatus('paused');
            }
          }),
        );
        if (
          disposed ||
          finished ||
          scannedUriRef.current ||
          view.$leaving ||
          !view.$match.$exact.$active
        )
          return;

        await QrScanner.startScan({scanId, previewBounds: measure()});
        if (
          disposed ||
          finished ||
          scannedUriRef.current ||
          view.$leaving ||
          !view.$match.$exact.$active
        )
          return;

        started = true;
        revealRef.current = duration =>
          QrScanner.animatePreview({
            scanId,
            fromScale: scanAttempt.resuming ? 1 : 0.5,
            toScale: 1,
            duration: scanAttempt.resuming ? 0 : duration,
            easing: SCAN_REVEAL_CURVE,
          }).then(
            () => true,
            error => {
              fail(error);
              return false;
            },
          );
        setStatus('scanning');
        observer.observe(previewRef.current!);
        window.addEventListener('resize', resize);
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
        revealRef.current = undefined;
        completeRef.current = undefined;
        observer.disconnect();
        window.removeEventListener('resize', resize);
        for (const listener of listeners.splice(0)) {
          errorService.catch(listener.remove());
        }
        qrScanLifecycle.closing = Promise.all([
          qrScanLifecycle.closing,
          stop().catch(error => errorService.catch(Promise.reject(error))),
        ]).then(() => undefined);
      };
    }, [scanAttempt, cameraVisible, errorService, view, acceptUri, toast]);

    useEffect(() => {
      if (!connecting || !active) return;

      const scannedUri = scannedUriRef.current;
      if (!scannedUri) return;

      if (scannedUri.consumed) {
        // A consumed QR code starts a new scan when this page is revisited.
        setStatus('starting');
        setScanAttempt(attempt => ({
          number: attempt.number + 1,
          resuming: false,
        }));
        return;
      }

      if (scannedUri.kind === 'otp') return;

      const controller = new AbortController();
      scannedUri.consumed = true;

      void walletKitService
        .connect(scannedUri.uri, controller.signal)
        .then(proposal => {
          if (!proposal) return;

          if (
            controller.signal.aborted ||
            view.$leaving ||
            !view.$match.$exact.$active
          ) {
            return;
          }

          setConnectionResult({
            proposalId: proposal.id,
            signal: controller.signal,
          });
        })
        .catch(error => {
          if (!controller.signal.aborted) {
            setConnectionResult({error, signal: controller.signal});
          }
        });

      return () => {
        controller.abort();
      };
    }, [connecting, active, walletKitService, view]);

    useEffect(() => {
      if (status !== 'scanned' || settledPhase !== 'scanned' || !active) return;

      const scanned = scannedUriRef.current;
      if (scanned?.kind === 'otp') {
        if (scanned.consumed) return;
        scanned.consumed = true;
        const importId = otpStore.prepareImport(scanned.uri);
        scanned.uri = '';
        errorService.catch(
          (async () => {
            try {
              await router.otp({importId}).$push().$completed;
            } finally {
              otpStore.discardImport(importId);
            }
          })(),
        );
        return;
      }

      if (!connectionResult || connectionResult.signal.aborted) return;

      if ('error' in connectionResult) {
        scannedUriRef.current = undefined;
        setStatus('error');
        errorService.catch(Promise.reject(connectionResult.error));
      } else {
        router.scan.connection({id: connectionResult.proposalId}).$push();
      }
    }, [
      status,
      settledPhase,
      active,
      connectionResult,
      router,
      otpStore,
      errorService,
    ]);

    const scanning =
      status === 'starting' || status === 'scanning' || status === 'completing';
    const phase = scanning || status === 'scanned' ? status : 'idle';
    const instructionsVisible =
      settledPhase === phase && phase !== 'starting' && phase !== 'completing';
    const keywordsVisible = instructionsVisible && phase === 'scanning';
    const statusVisible = instructionsVisible && phase === 'idle';
    const pasteVisible =
      controlsPhase === phase && (phase === 'scanning' || phase === 'idle');

    useEffect(() => {
      setControlsPhase(undefined);
      if (phase !== 'scanning' && phase !== 'idle') return;

      const delay = window.matchMedia('(prefers-reduced-motion: reduce)')
        .matches
        ? 0
        : SCAN_REVEAL_DURATION - 160;
      const timer = setTimeout(() => setControlsPhase(phase), delay);
      return () => clearTimeout(timer);
    }, [phase]);

    return (
      <Container>
        {(status === 'scanning' || status === 'completing') && (
          <CameraBackground />
        )}
        <Header>
          <ViewHeaderTitle>Scan</ViewHeaderTitle>
          <HeaderKeyword $visible={keywordsVisible} active={keywordsVisible} />
        </Header>
        <Content>
          <Preview
            ref={previewRef}
            $open={status === 'scanning' || status === 'completing'}
            aria-label="Camera preview"
          >
            <QrScanPreview
              phase={phase}
              revealMode={scanAttempt.resuming ? 'fade' : 'zoom'}
              onReveal={duration =>
                revealRef.current?.(duration) ?? Promise.resolve(false)
              }
              onCovered={() => {
                if (completeRef.current) {
                  completeRef.current();
                } else if (active) {
                  setStatus('scanned');
                }
              }}
              onSettled={setSettledPhase}
            />
            <StatusMessage
              $visible={statusVisible}
              aria-live="polite"
              aria-hidden={!statusVisible}
            >
              {status !== 'scanning' &&
                status !== 'completing' &&
                status !== 'scanned' &&
                STATUS_TEXT[status]}
            </StatusMessage>
          </Preview>
          <Controls
            $visible={pasteVisible}
            aria-hidden={!pasteVisible}
            inert={!pasteVisible}
          >
            <Button
              color="neutral"
              disabled={!active || !pasteVisible || connecting}
              loading={pasting}
              onClick={() => void paste()}
            >
              Clipboard
            </Button>
          </Controls>
        </Content>
      </Container>
    );
  },
);
