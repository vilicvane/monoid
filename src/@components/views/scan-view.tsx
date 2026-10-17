import {Capacitor, type PluginListenerHandle} from '@capacitor/core';
import {
  QrScanner,
  type QrScannerError,
  type QrScannerPreviewBounds,
} from 'capacitor-qr-scanner';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {createGlobalStyle, css, styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {parseWalletConnectUri} from '../../@lib/wallet-connect.js';
import type {Router} from '../../@routes.js';
import {
  SCAN_REVEAL_CURVE,
  SCAN_REVEAL_DURATION,
  SCAN_REVEAL_EASING,
} from '../@ui/scan-motion.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

import {QrScanInstructions} from './@scan/qr-scan-instructions.js';
import {
  QrScanPreview,
  type QrScanPreviewPhase,
  SCAN_CIRCLE_INSET,
} from './@scan/qr-scan-preview.js';

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
    grid-template-rows: minmax(0, 1fr) var(--scan-preview-size) minmax(0, 1fr);
    justify-items: center;
    gap: 0;
    overflow: hidden;

    @media (max-height: 600px) and (orientation: landscape) {
      --scan-preview-size: min(240px, 40vh, 40vw);

      grid-template-rows: minmax(0, 1fr);
      grid-template-columns: var(--scan-preview-size) minmax(0, 320px);
      align-items: center;
      justify-content: center;
      gap: 24px;
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

const Instructions = styled.div<{
  $visible: boolean;
  $compact: boolean;
  $centered: boolean;
}>`
  --instructions-offset: ${props =>
    props.$compact
      ? `calc(var(--scan-preview-size) * -${SCAN_CIRCLE_INSET / 100})`
      : '0px'};

  position: relative;
  z-index: 1;
  grid-row: 3;
  align-self: start;
  box-sizing: border-box;
  width: min(100%, 320px);
  padding-top: 24px;
  text-align: center;
  max-height: 144px;
  overflow: auto;
  opacity: ${props => (props.$visible ? 1 : 0)};
  transform: translateY(
    calc(
      var(--instructions-offset) + ${props => (props.$visible ? '0px' : '4px')}
    )
  );
  pointer-events: ${props => (props.$visible ? 'auto' : 'none')};
  transition:
    opacity 160ms ease-out,
    transform 160ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  @media (max-height: 600px) and (orientation: landscape) {
    --instructions-offset: 0px;

    grid-row: 1;
    padding-top: 0;
  }

  ${props =>
    props.$centered &&
    css`
      --instructions-offset: 0px;

      grid-area: 1 / 1 / -1 / -1;
      align-self: center;
      padding-top: 0;
    `}

  p {
    margin: 0;
    color: var(--color-text-secondary);
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

// Keep the same object across hot updates: the old effect's cleanup runs after
// the new module has loaded, and must still block its next camera startup.
const scanLifecycle: {closing: Promise<void>} = import.meta.hot?.data
  .scanLifecycle ?? {
  closing: Promise.resolve(),
};

if (import.meta.hot) {
  import.meta.hot.data.scanLifecycle = scanLifecycle;
}

export const ScanView = observer(
  ({view}: RouteComponentProps<Router['scan']>): ReactNode => {
    const {router, walletKitService, errorService} = useEntrances();
    const previewRef = useRef<HTMLDivElement>(null);
    const revealRef = useRef<(duration: number) => Promise<boolean>>(undefined);
    const completeRef = useRef<() => void>(undefined);
    const scannedUriRef = useRef<{uri: string; consumed: boolean}>(undefined);
    const [scanAttempt, setScanAttempt] = useState(0);
    const [status, setStatus] = useState<ScanStatus>('starting');
    const [settledPhase, setSettledPhase] = useState<QrScanPreviewPhase>();
    const [connectionResult, setConnectionResult] = useState<
      ({proposalId: number} | {error: unknown}) & {signal: AbortSignal}
    >();
    const connecting = status === 'completing' || status === 'scanned';
    const active = !view.$leaving && view.$match.$exact.$active;
    const cameraVisible =
      active ||
      (!!view.$leaving && (status === 'scanning' || status === 'completing'));

    useEffect(() => {
      if (!cameraVisible) {
        return;
      }

      if (
        Capacitor.getPlatform() !== 'android' ||
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
      let started = false;
      let stopped: Promise<void> | undefined;

      const stop = (): Promise<void> =>
        (stopped ??= QrScanner.stopScan({scanId}));
      const fail = (error: unknown): void => {
        if (!disposed && !finished) {
          finished = true;
          const {code} = error as QrScannerError;
          if (code === 'CANCELLED' || code === 'APP_INACTIVE') {
            setStatus('paused');
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

      setStatus('starting');
      setSettledPhase(undefined);
      setConnectionResult(undefined);
      scannedUriRef.current = undefined;

      void (async () => {
        await scanLifecycle.closing;
        if (disposed) return;

        let permissions = await QrScanner.checkPermissions();
        if (disposed) return;

        if (permissions.camera !== 'granted') {
          permissions = await QrScanner.requestPermissions();
        }
        if (disposed) return;

        if (permissions.camera !== 'granted') {
          setStatus('denied');
          return;
        }

        listeners.push(
          await QrScanner.addListener('codesScanned', event => {
            if (
              event.scanId !== scanId ||
              disposed ||
              finished ||
              view.$leaving ||
              !view.$match.$exact.$active
            )
              return;

            const uri = event.values
              .map(value => parseWalletConnectUri(value))
              .find(value => value !== undefined);
            if (!uri) return;

            scannedUriRef.current = {uri, consumed: false};
            finished = true;
            completeRef.current = () => {
              completeRef.current = undefined;
              if (disposed) return;

              // Hide the camera only after the success cover is fully opaque.
              errorService.catch(
                stop().finally(() => {
                  if (!disposed) setStatus('scanned');
                }),
              );
            };
            setStatus('completing');
          }),
        );
        if (disposed) return;

        listeners.push(
          await QrScanner.addListener('scanEnded', event => {
            if (event.scanId !== scanId || disposed || finished) return;

            if (event.reason === 'error') {
              fail(new Error(event.message));
            } else {
              finished = true;
              setStatus('paused');
            }
          }),
        );
        if (disposed || view.$leaving || !view.$match.$exact.$active) return;

        await QrScanner.startScan({scanId, previewBounds: measure()});
        if (
          disposed ||
          finished ||
          view.$leaving ||
          !view.$match.$exact.$active
        )
          return;

        started = true;
        revealRef.current = duration =>
          QrScanner.animatePreview({
            scanId,
            fromScale: 0.5,
            toScale: 1,
            duration,
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
        revealRef.current = undefined;
        completeRef.current = undefined;
        observer.disconnect();
        window.removeEventListener('resize', resize);
        for (const listener of listeners.splice(0)) {
          errorService.catch(listener.remove());
        }
        scanLifecycle.closing = Promise.all([
          scanLifecycle.closing,
          stop().catch(error => errorService.catch(Promise.reject(error))),
        ]).then(() => undefined);
      };
    }, [scanAttempt, cameraVisible, errorService, view]);

    useEffect(() => {
      if (!connecting || !active) return;

      const scannedUri = scannedUriRef.current;
      if (!scannedUri) return;

      if (scannedUri.consumed) {
        // A consumed QR code starts a new scan when this page is revisited.
        setStatus('starting');
        setScanAttempt(attempt => attempt + 1);
        return;
      }

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
      if (
        status !== 'scanned' ||
        settledPhase !== 'scanned' ||
        !active ||
        !connectionResult ||
        connectionResult.signal.aborted
      )
        return;

      if ('error' in connectionResult) {
        setStatus('error');
        errorService.catch(Promise.reject(connectionResult.error));
      } else {
        router.scan.connection({id: connectionResult.proposalId}).$push();
      }
    }, [status, settledPhase, active, connectionResult, router, errorService]);

    const scanning =
      status === 'starting' || status === 'scanning' || status === 'completing';
    const phase = scanning || status === 'scanned' ? status : 'idle';
    const instructionsVisible =
      settledPhase === phase && phase !== 'starting' && phase !== 'completing';
    const keywordsVisible = instructionsVisible && phase === 'scanning';
    const statusVisible = instructionsVisible && phase === 'idle';

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
              onReveal={duration =>
                revealRef.current?.(duration) ?? Promise.resolve(false)
              }
              onCovered={() => completeRef.current?.()}
              onSettled={setSettledPhase}
            />
          </Preview>
          <Instructions
            $visible={statusVisible}
            $compact={phase !== 'scanning' && phase !== 'completing'}
            $centered={phase === 'idle'}
            aria-live="polite"
            aria-hidden={!statusVisible}
            inert={!statusVisible}
          >
            {status !== 'scanning' &&
              status !== 'completing' &&
              status !== 'scanned' && <p>{STATUS_TEXT[status]}</p>}
          </Instructions>
        </Content>
      </Container>
    );
  },
);
