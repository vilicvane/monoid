package app.monoid.plugins.qrscanner;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Serial scan lifecycle. Camera callbacks and callers use the main thread. */
final class QrScanController {
    interface Session {
        void update(QrPreviewSurface.Bounds bounds);
        void animate(QrPreviewSurface.Animation animation);
        void close(Runnable onClosed);
    }

    interface Factory {
        // Startup callbacks must run after open returns its cancellable handle.
        Session open(QrPreviewSurface.Bounds bounds, QrCameraSession.Listener listener);
    }

    interface Result {
        void resolve();
        void reject(String code, String message);
    }

    interface Listener {
        void codes(String scanId, List<String> values);
        void ended(String scanId, String reason, String code, String message);
    }

    private final Factory factory;
    private final Listener listener;
    private final Set<String> retired = new HashSet<>();
    private Scan current;

    QrScanController(Factory factory, Listener listener) {
        this.factory = factory;
        this.listener = listener;
    }

    void start(String id, QrPreviewSurface.Bounds bounds, Result result) {
        if (retired.contains(id)) {
            result.reject("SCAN_CLOSED", "This scan ID has already ended.");
            return;
        }
        if (current != null) {
            result.reject("BUSY", "Another scan is starting or active.");
            return;
        }
        Scan scan = new Scan(id, result);
        current = scan;
        try {
            scan.session = factory.open(bounds, new QrCameraSession.Listener() {
                @Override
                public void onStarted() {
                    if (current == scan && !scan.started && !scan.closing) {
                        scan.started = true;
                        result.resolve();
                    }
                }

                @Override
                public void onCodes(List<String> values) {
                    if (current == scan && scan.started && !scan.closing) {
                        listener.codes(id, values);
                    }
                }

                @Override
                public void onError(String code, Exception error) {
                    if (current == scan && !scan.closing) {
                        close(scan, "error", code, message(error));
                    }
                }
            });
        } catch (Exception error) {
            close(scan, "error", "CAMERA_ERROR", message(error));
        }
    }

    void update(String id, QrPreviewSurface.Bounds bounds, Result result) {
        if (current == null || !current.id.equals(id) || current.closing) {
            result.reject("SCAN_CLOSED", "This scan is no longer active.");
            return;
        }
        try {
            current.session.update(bounds);
            result.resolve();
        } catch (IllegalStateException error) {
            result.reject("SCAN_CLOSED", "This scan is no longer active.");
        }
    }

    void stop(String id, Result result) {
        retired.add(id);
        if (current == null || !current.id.equals(id)) {
            result.resolve();
            return;
        }
        current.stops.add(result);
        close(current, "stopped", "CANCELLED", "Scan startup was cancelled.");
    }

    void animate(String id, QrPreviewSurface.Animation animation, Result result) {
        if (current == null || !current.id.equals(id) || !current.started || current.closing) {
            result.reject("SCAN_CLOSED", "The camera preview is not active.");
            return;
        }
        try {
            current.session.animate(animation);
            result.resolve();
        } catch (IllegalStateException error) {
            result.reject("SCAN_CLOSED", "The camera preview is not active.");
        } catch (IllegalArgumentException error) {
            result.reject("INVALID_ARGUMENT", message(error));
        }
    }

    void pause() {
        if (current != null) {
            close(current, "app-paused", "CANCELLED", "Scan startup was cancelled because the app paused.");
        }
    }

    void reset() {
        if (current != null) {
            // The old JavaScript document is gone; do not deliver its pending calls or events.
            current.silent = true;
            close(current, "stopped", "CANCELLED", "Scan startup was cancelled.");
        }
        retired.clear();
    }

    private void close(Scan scan, String reason, String code, String message) {
        if (scan.closing) {
            return;
        }
        scan.closing = true;
        retired.add(scan.id);
        Runnable finish = () -> {
            current = null;
            if (!scan.silent) {
                if (!scan.started) {
                    scan.start.reject(code, message);
                } else {
                    listener.ended(scan.id, reason, "error".equals(reason) ? code : null, message);
                }
                for (Result stop : scan.stops) {
                    stop.resolve();
                }
            }
        };
        if (scan.session == null) {
            finish.run();
        } else {
            scan.session.close(finish);
        }
    }

    private static String message(Exception error) {
        return error.getMessage() == null ? "QR scanning failed." : error.getMessage();
    }

    private static final class Scan {
        final String id;
        final Result start;
        final List<Result> stops = new ArrayList<>();
        Session session;
        boolean started;
        boolean closing;
        boolean silent;

        Scan(String id, Result start) {
            this.id = id;
            this.start = start;
        }
    }
}
