package app.monoid.plugins.qrscanner;

import android.Manifest;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.util.WebColor;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.List;
import org.json.JSONObject;

@CapacitorPlugin(name = "QrScanner", permissions = {
    @Permission(alias = "camera", strings = {Manifest.permission.CAMERA})
})
public final class QrScannerPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private QrScanController scans;
    private boolean resumed;
    private boolean destroyed;
    private long document;
    private long workerDocument;
    private final WebViewListener webViewListener = new WebViewListener() {
        @Override
        public void onPageStarted(WebView webView) {
            resetDocument();
        }

        @Override
        public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
            resetDocument();
            return false;
        }
    };

    @Override
    public void load() {
        resumed = getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
        scans = new QrScanController(PendingCamera::new, new QrScanController.Listener() {
            @Override
            public void codes(String scanId, List<String> values) {
                JSObject event = new JSObject();
                event.put("scanId", scanId);
                event.put("values", new JSArray(values));
                notifyListeners("codesScanned", event);
            }

            @Override
            public void ended(String scanId, String reason, String code, String message) {
                JSObject event = new JSObject();
                event.put("scanId", scanId);
                event.put("reason", reason);
                if (code != null) {
                    event.put("code", code);
                    event.put("message", message);
                }
                notifyListeners("scanEnded", event);
            }
        });
        // Bridge.Builder replaces its listener list after loading plugins.
        // Register on the next main-thread turn, once bridge construction is complete.
        main.post(() -> {
            if (!destroyed) {
                bridge.addWebViewListener(webViewListener);
            }
        });
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        dispatch(() -> {
            String id = scanId(call);
            if (id == null) {
                return;
            }
            QrPreviewSurface.Bounds bounds = bounds(call);
            if (bounds == null) {
                return;
            }
            if (destroyed || !resumed || !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
                call.reject("The app must be active to scan QR codes.", "APP_INACTIVE");
            } else if (getPermissionState("camera") != PermissionState.GRANTED) {
                call.reject("Camera permission is required.", "PERMISSION_DENIED");
            } else {
                scans.start(id, bounds, result(call));
            }
        });
    }

    @PluginMethod
    public void updatePreviewBounds(PluginCall call) {
        dispatch(() -> {
            String id = scanId(call);
            if (id == null) {
                return;
            }
            QrPreviewSurface.Bounds bounds = bounds(call);
            if (bounds != null) {
                scans.update(id, bounds, result(call));
            }
        });
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        dispatch(() -> {
            String id = scanId(call);
            if (id != null) {
                scans.stop(id, result(call));
            }
        });
    }

    private void dispatch(Runnable action) {
        long source = workerDocument;
        main.post(() -> {
            if (source == document) {
                action.run();
            }
        });
    }

    private void resetDocument() {
        long next = ++document;
        scans.reset();
        // Plugin invocations queued before navigation still belong to the old document.
        // Advance the worker only after those invocations have captured their generation.
        bridge.execute(() -> workerDocument = next);
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
    }

    @Override
    protected void handleOnPause() {
        resumed = false;
        scans.pause();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        resumed = false;
        document++;
        scans.reset();
        bridge.removeWebViewListener(webViewListener);
    }

    private QrPreviewSurface.Bounds bounds(PluginCall call) {
        Object value = call.getData().opt("previewBounds");
        if (value instanceof JSONObject object) {
            Object x = object.opt("x");
            Object y = object.opt("y");
            Object width = object.opt("width");
            Object height = object.opt("height");
            if (x instanceof Number && y instanceof Number && width instanceof Number && height instanceof Number) {
                try {
                    QrPreviewSurface.Bounds bounds = new QrPreviewSurface.Bounds(((Number) x).doubleValue(),
                        ((Number) y).doubleValue(), ((Number) width).doubleValue(), ((Number) height).doubleValue());
                    WebView view = bridge.getWebView();
                    QrPreviewSurface.Pixels pixels = bounds.toPixels(view.getWidth(), view.getHeight());
                    if (view.getWidth() > 0 && view.getHeight() > 0 && (pixels.width() == 0 || pixels.height() == 0)) {
                        call.reject("Preview bounds must cover at least one pixel.", "INVALID_ARGUMENT");
                        return null;
                    }
                    return bounds;
                } catch (IllegalArgumentException error) {
                    call.reject(error.getMessage(), "INVALID_ARGUMENT");
                    return null;
                }
            }
        }
        call.reject("previewBounds must contain numeric x, y, width and height.", "INVALID_ARGUMENT");
        return null;
    }

    private static String scanId(PluginCall call) {
        Object value = call.getData().opt("scanId");
        if (value instanceof String id && !id.trim().isEmpty()) {
            return id;
        }
        call.reject("scanId must be a nonblank string.", "INVALID_ARGUMENT");
        return null;
    }

    private static QrScanController.Result result(PluginCall call) {
        return new QrScanController.Result() {
            @Override
            public void resolve() {
                call.resolve();
            }

            @Override
            public void reject(String code, String message) {
                call.reject(message, code);
            }
        };
    }

    /** A handle exists before CameraX initialization finishes, so pending starts are cancellable. */
    private final class PendingCamera implements QrScanController.Session {
        private QrPreviewSurface.Bounds bounds;
        private QrCameraSession camera;
        private boolean closed;

        PendingCamera(QrPreviewSurface.Bounds bounds, QrCameraSession.Listener listener) {
            this.bounds = bounds;
            ListenableFuture<ProcessCameraProvider> provider = ProcessCameraProvider.getInstance(getContext());
            provider.addListener(() -> {
                if (closed) {
                    return;
                }
                try {
                    String background = bridge.getConfig().getBackgroundColor();
                    int color = background == null ? Color.WHITE : WebColor.parseColor(background);
                    camera = new QrCameraSession(provider.get(), bridge.getWebView(), color, this.bounds, listener);
                } catch (Exception error) {
                    listener.onError("CAMERA_ERROR", error);
                }
            }, main::post);
        }

        @Override
        public void update(QrPreviewSurface.Bounds bounds) {
            this.bounds = bounds;
            if (camera != null) {
                camera.updatePreviewBounds(bounds);
            }
        }

        @Override
        public void close(Runnable onClosed) {
            closed = true;
            if (camera == null) {
                onClosed.run();
            } else {
                camera.close(onClosed);
            }
        }
    }
}
