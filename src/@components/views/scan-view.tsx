import {Capacitor, type PluginListenerHandle} from '@capacitor/core';
import {
  QrScanner,
  type QrScannerError,
  type QrScannerPreviewBounds,
} from 'capacitor-qr-scanner';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {createGlobalStyle, keyframes, styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {Button} from '../@ui/button.js';
import {SCAN_REVEAL_DURATION, SCAN_REVEAL_EASING} from '../@ui/scan-motion.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

import {
  QrScanPreview,
  type QrScanPreviewPhase,
  SCAN_CIRCLE_INSET,
  SCAN_FRAME_OFFSET,
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

const Content = styled(ViewContent)`
  --scan-preview-size: min(320px, 45vh, calc(100vw - var(--view-padding) * 2));

  display: grid;
  grid-template-rows:
    max(0px, calc((100% - var(--scan-preview-size)) / 2 - 16px))
    var(--scan-preview-size)
    minmax(0, 1fr);
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
`;

const Preview = styled.div<{$open: boolean}>`
  position: relative;
  top: -${SCAN_FRAME_OFFSET}px;
  grid-row: 2;
  width: var(--scan-preview-size);
  aspect-ratio: 1;
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

const Instructions = styled.div<{$visible: boolean; $compact: boolean}>`
  --instructions-offset: ${props =>
    props.$compact
      ? `calc(var(--scan-preview-size) * -${SCAN_CIRCLE_INSET / 100})`
      : `-${SCAN_FRAME_OFFSET}px`};

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

  p {
    margin: 0 0 16px;
    color: var(--color-text-secondary);
  }

  button {
    width: 100%;
  }
`;

const revealResult = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
`;

const Result = styled.p`
  max-height: 6em;
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
  animation: ${revealResult} 160ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
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

const STATUS_TEXT: Record<ScanStatus, string> = {
  starting: 'Opening camera…',
  scanning: 'Place a QR code inside the frame',
  completing: 'QR code scanned',
  scanned: 'QR code scanned',
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
    const {errorService} = useEntrances();
    const previewRef = useRef<HTMLDivElement>(null);
    const completeRef = useRef<() => void>(undefined);
    const [attempt, setAttempt] = useState(0);
    const [status, setStatus] = useState<ScanStatus>('starting');
    const [result, setResult] = useState<string>();
    const [settledPhase, setSettledPhase] = useState<QrScanPreviewPhase>();
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
      setResult(undefined);
      setSettledPhase(undefined);

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
              !view.$match.$exact.$active ||
              !event.values.length
            )
              return;

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
            setResult(event.values[0]);
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
    }, [cameraVisible, attempt, errorService, view]);

    const scanning =
      status === 'starting' || status === 'scanning' || status === 'completing';
    const phase = scanning || status === 'scanned' ? status : 'idle';
    const instructionsVisible =
      settledPhase === phase && phase !== 'starting' && phase !== 'completing';

    return (
      <Container>
        {scanning && <CameraBackground />}
        <Header>
          <ViewHeaderTitle>Scan</ViewHeaderTitle>
        </Header>
        <Content>
          <Preview
            ref={previewRef}
            $open={status === 'scanning' || status === 'completing'}
            aria-label="Camera preview"
          >
            <QrScanPreview
              phase={phase}
              onCovered={() => completeRef.current?.()}
              onSettled={setSettledPhase}
            />
          </Preview>
          <Instructions
            $visible={instructionsVisible}
            $compact={phase !== 'scanning' && phase !== 'completing'}
            aria-live="polite"
            aria-hidden={!instructionsVisible}
            inert={!instructionsVisible}
          >
            <p>{STATUS_TEXT[status]}</p>
            {status === 'scanned' && <Result>{result}</Result>}
            {!scanning && status !== 'unsupported' && (
              <Button onClick={() => setAttempt(value => value + 1)}>
                Scan again
              </Button>
            )}
          </Instructions>
        </Content>
      </Container>
    );
  },
);
