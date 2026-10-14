package app.monoid.plugins.qrscanner;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import java.util.List;
import org.junit.Test;

public class QrScanControllerTest {
    private static final QrPreviewSurface.Bounds BOUNDS = new QrPreviewSurface.Bounds(0, 0, 1, 1);
    private final QrScanController.Listener listener = mock(QrScanController.Listener.class);
    private final Camera camera = new Camera();
    private final QrScanController scans = new QrScanController(camera, listener);

    @Test
    public void preCancelledAndBusyStartsCannotOpenAnotherCamera() {
        QrScanController.Result cancelled = mock(QrScanController.Result.class);
        QrScanController.Result start = mock(QrScanController.Result.class);
        QrScanController.Result busy = mock(QrScanController.Result.class);
        scans.stop("cancelled", cancelled);
        verify(cancelled).resolve();
        scans.start("cancelled", BOUNDS, cancelled);
        verify(cancelled).reject(eq("SCAN_CLOSED"), anyString());
        scans.start("first", BOUNDS, start);
        scans.start("second", BOUNDS, busy);
        verify(busy).reject(eq("BUSY"), anyString());
        assertEquals(1, camera.opens);
    }

    @Test
    public void detectionsWaitUntilTheFirstPreviewFrameIsReady() {
        QrScanController.Result start = mock(QrScanController.Result.class);
        scans.start("first", BOUNDS, start);
        camera.events.onCodes(List.of("before preview"));
        verifyNoInteractions(start, listener);

        camera.events.onStarted();
        camera.events.onCodes(List.of("visible preview"));
        verify(start).resolve();
        verify(listener).codes("first", List.of("visible preview"));
        verifyNoMoreInteractions(listener);
    }

    @Test
    public void cancellingPendingStartWaitsForCleanupAndSuppressesLateCallbacks() {
        QrScanController.Result start = mock(QrScanController.Result.class);
        QrScanController.Result stop = mock(QrScanController.Result.class);
        QrScanController.Result secondStop = mock(QrScanController.Result.class);
        scans.start("first", BOUNDS, start);
        scans.stop("first", stop);
        scans.stop("first", secondStop);
        camera.events.onStarted();
        camera.events.onCodes(List.of("late"));
        camera.events.onError("CAMERA_ERROR", new Exception("late"));
        verifyNoInteractions(start, stop, secondStop, listener);
        camera.finishClose.run();
        verify(start).reject(eq("CANCELLED"), anyString());
        verify(stop).resolve();
        verify(secondStop).resolve();
        verifyNoInteractions(listener);
        assertEquals(1, camera.closes);
    }

    @Test
    public void stoppingAnotherIdDoesNotEndActiveScan() {
        QrScanController.Result start = mock(QrScanController.Result.class);
        QrScanController.Result stop = mock(QrScanController.Result.class);
        scans.start("first", BOUNDS, start);
        camera.events.onStarted();
        camera.events.onStarted();
        verify(start).resolve();
        scans.stop("other", stop);
        verify(stop).resolve();
        assertEquals(0, camera.closes);
        camera.events.onCodes(List.of("raw value"));
        verify(listener).codes("first", List.of("raw value"));
    }

    @Test
    public void pauseEndsActiveScanOnceAfterCleanupAndRetiresItsId() {
        QrScanController.Result start = mock(QrScanController.Result.class);
        scans.start("first", BOUNDS, start);
        camera.events.onStarted();
        scans.pause();
        scans.pause();
        camera.events.onCodes(List.of("late"));
        verifyNoInteractions(listener);
        camera.finishClose.run();
        verify(listener).ended(eq("first"), eq("app-paused"), isNull(), anyString());
        scans.start("first", BOUNDS, start);
        verify(start).reject(eq("SCAN_CLOSED"), anyString());
    }

    @Test
    public void startupFailureRejectsWhileRuntimeFailureEmitsAnEvent() {
        QrScanController.Result start = mock(QrScanController.Result.class);
        scans.start("first", BOUNDS, start);
        camera.events.onError("NO_CAMERA", new Exception("No camera"));
        camera.finishClose.run();
        verify(start).reject("NO_CAMERA", "No camera");
        verifyNoInteractions(listener);

        scans.start("second", BOUNDS, start);
        camera.events.onStarted();
        camera.events.onError("DETECTION_ERROR", new Exception());
        camera.finishClose.run();
        verify(listener).ended("second", "error", "DETECTION_ERROR", "QR scanning failed.");
    }

    @Test
    public void reloadSuppressesOldDocumentAndAllowsFreshIdsAfterCleanup() {
        QrScanController.Result oldStart = mock(QrScanController.Result.class);
        QrScanController.Result newStart = mock(QrScanController.Result.class);
        scans.start("first", BOUNDS, oldStart);
        QrCameraSession.Listener oldEvents = camera.events;
        scans.reset();
        camera.finishClose.run();
        scans.start("first", BOUNDS, newStart);
        oldEvents.onStarted();
        oldEvents.onCodes(List.of("late"));
        oldEvents.onError("CAMERA_ERROR", new Exception("late"));
        verifyNoInteractions(oldStart, newStart, listener);
        camera.events.onStarted();
        verify(newStart).resolve();
    }

    @Test
    public void layoutUpdatesAreAcceptedUntilClosing() {
        QrScanController.Result start = mock(QrScanController.Result.class);
        QrScanController.Result update = mock(QrScanController.Result.class);
        QrPreviewSurface.Bounds next = new QrPreviewSurface.Bounds(0.1, 0.1, 0.8, 0.8);
        scans.start("first", BOUNDS, start);
        scans.update("first", next, update);
        assertEquals(next, camera.bounds);
        verify(update).resolve();
        scans.pause();
        scans.update("first", next, update);
        verify(update).reject(eq("SCAN_CLOSED"), anyString());
    }

    private static final class Camera implements QrScanController.Factory, QrScanController.Session {
        QrCameraSession.Listener events;
        QrPreviewSurface.Bounds bounds;
        Runnable finishClose;
        int opens;
        int closes;

        @Override
        public QrScanController.Session open(QrPreviewSurface.Bounds bounds, QrCameraSession.Listener events) {
            this.events = events;
            this.bounds = bounds;
            opens++;
            return this;
        }

        @Override
        public void update(QrPreviewSurface.Bounds bounds) {
            this.bounds = bounds;
        }

        @Override
        public void close(Runnable onClosed) {
            closes++;
            finishClose = onClosed;
        }
    }
}
