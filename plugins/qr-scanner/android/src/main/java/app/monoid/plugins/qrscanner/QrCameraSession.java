package app.monoid.plugins.qrscanner;

import android.webkit.WebView;
import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.CameraState;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.core.UseCaseGroup;
import androidx.camera.core.ViewPort;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LifecycleRegistry;
import androidx.lifecycle.Observer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/** One camera session, with all state and analyzer callbacks confined to the main thread. */
@MainThread
final class QrCameraSession implements LifecycleOwner {
    interface Listener {
        void onStarted();
        void onCodes(List<String> values);
        void onError(String code, Exception error);
    }

    private final LifecycleRegistry lifecycle = new LifecycleRegistry(this);
    private final ProcessCameraProvider provider;
    private final WebView webView;
    private final QrPreviewSurface surface;
    private final Executor executor;
    private final Listener listener;
    private final List<Runnable> onClosed = new ArrayList<>();
    private Camera camera;
    private Preview preview;
    private ImageAnalysis analysis;
    private QrCodeAnalyzer analyzer;
    private QrPreviewSurface.Viewport boundViewport;
    private boolean refreshPosted;
    private boolean started;
    private boolean previewWasIdle;
    private boolean draining;
    private boolean closing;
    private boolean closed;
    private final Observer<CameraState> cameraState = state -> {
        if (!closing && !draining && state.getError() != null) {
            fail("CAMERA_ERROR", new IllegalStateException("Camera error " + state.getError().getCode(), state.getError().getCause()));
        }
    };
    private final Observer<PreviewView.StreamState> previewState = this::onPreviewState;

    QrCameraSession(ProcessCameraProvider provider, WebView webView, int restoreColor,
        QrPreviewSurface.Bounds bounds, Listener listener) {
        this.provider = provider;
        this.webView = webView;
        this.listener = listener;
        executor = ContextCompat.getMainExecutor(webView.getContext());
        lifecycle.setCurrentState(Lifecycle.State.CREATED);
        surface = new QrPreviewSurface(webView, restoreColor, bounds, this::requestRefresh);
        requestRefresh();
    }

    @NonNull
    @Override
    public Lifecycle getLifecycle() {
        return lifecycle;
    }

    void updatePreviewBounds(QrPreviewSurface.Bounds bounds) {
        if (closing) {
            throw new IllegalStateException("The camera session is closed.");
        }
        surface.update(bounds);
        requestRefresh();
    }

    void animatePreview(QrPreviewSurface.Animation animation) {
        if (!started || closing) {
            throw new IllegalStateException("The camera preview is not active.");
        }
        surface.animate(animation);
    }

    private void requestRefresh() {
        if (closing || refreshPosted) {
            return;
        }
        refreshPosted = true;
        // PreviewView may request layout when a SurfaceRequest replaces its TextureView.
        // Wait until layout has finished and only rebind if the viewport actually changed.
        webView.post(() -> {
            refreshPosted = false;
            refresh();
        });
    }

    private void refresh() {
        if (closing || draining) {
            return;
        }
        if (surface.hasEmptyBounds()) {
            fail("INVALID_ARGUMENT", new IllegalArgumentException("Preview bounds must cover at least one pixel."));
            return;
        }
        QrPreviewSurface.Viewport viewport = surface.viewport();
        if (viewport == null || viewport.equals(boundViewport)) {
            return;
        }
        drain(() -> {
            if (closing) {
                finishClose();
            } else {
                bind();
            }
        });
    }

    private void bind() {
        if (surface.hasEmptyBounds()) {
            fail("INVALID_ARGUMENT", new IllegalArgumentException("Preview bounds must cover at least one pixel."));
            return;
        }
        QrPreviewSurface.Viewport geometry = surface.viewport();
        if (geometry == null) {
            return;
        }
        ViewPort viewport = surface.view.getViewPort();
        if (viewport == null) {
            return;
        }

        try {
            if (!provider.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
                fail("NO_CAMERA", new IllegalStateException("No rear camera is available."));
                return;
            }
            int rotation = geometry.rotation();
            preview = new Preview.Builder().setTargetRotation(rotation).build();
            preview.setSurfaceProvider(surface.view.getSurfaceProvider());
            analysis = new ImageAnalysis.Builder().setTargetRotation(rotation)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
            analyzer = new QrCodeAnalyzer(executor, values -> {
                if (started && !closing && !draining && geometry.equals(surface.viewport())) {
                    listener.onCodes(values);
                }
            }, error -> fail("DETECTION_ERROR", error));
            analysis.setAnalyzer(executor, analyzer);
            camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA,
                new UseCaseGroup.Builder().setViewPort(viewport).addUseCase(preview).addUseCase(analysis).build());
            boundViewport = geometry;
            lifecycle.setCurrentState(Lifecycle.State.STARTED);
            camera.getCameraInfo().getCameraState().observe(this, cameraState);
            if (!started && !closing) {
                // A rebound PreviewView can still hold the previous stream's state.
                // Wait for the new stream to leave IDLE before reporting readiness.
                previewWasIdle = false;
                surface.view.getPreviewStreamState().observe(this, previewState);
            }
        } catch (Exception error) {
            fail("CAMERA_ERROR", error);
        }
    }

    private void onPreviewState(PreviewView.StreamState state) {
        if (started || closing || draining) {
            return;
        }
        if (state == PreviewView.StreamState.IDLE) {
            previewWasIdle = true;
        } else if (state == PreviewView.StreamState.STREAMING && previewWasIdle) {
            // COMPATIBLE mode reports STREAMING only after a TextureView frame arrives.
            started = true;
            listener.onStarted();
        }
    }

    private void drain(Runnable callback) {
        draining = true;
        surface.view.getPreviewStreamState().removeObserver(previewState);
        if (camera != null) {
            camera.getCameraInfo().getCameraState().removeObserver(cameraState);
        }
        if (analysis == null) {
            draining = false;
            callback.run();
            return;
        }
        analysis.clearAnalyzer();
        Runnable unbind = () -> {
            provider.unbind(preview, analysis);
            camera = null;
            preview = null;
            analysis = null;
            analyzer = null;
            boundViewport = null;
            draining = false;
            callback.run();
        };
        if (analyzer == null) {
            unbind.run();
        } else {
            analyzer.close(unbind);
        }
    }

    private void fail(String code, Exception error) {
        if (!closing) {
            close(() -> listener.onError(code, error));
        }
    }

    /** The bridge must call this when the app pauses or the WebView is destroyed/reloaded. */
    void close(Runnable callback) {
        if (closed) {
            callback.run();
            return;
        }
        onClosed.add(callback);
        if (closing) {
            return;
        }
        closing = true;
        surface.hide();
        if (!draining) {
            drain(this::finishClose);
        }
    }

    private void finishClose() {
        lifecycle.setCurrentState(Lifecycle.State.DESTROYED);
        surface.close();
        closed = true;
        for (Runnable callback : onClosed) {
            callback.run();
        }
        onClosed.clear();
    }
}
