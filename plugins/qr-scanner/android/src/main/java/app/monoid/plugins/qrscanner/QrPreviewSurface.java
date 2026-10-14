package app.monoid.plugins.qrscanner;

import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.camera.view.PreviewView;

/** Native preview below the WebView. All layout and cleanup run on the main thread. */
final class QrPreviewSurface {
    final PreviewView view;
    private final WebView webView;
    private final ViewGroup parent;
    private final FrameLayout container;
    private final int restoreColor;
    private final View.OnLayoutChangeListener viewportLayout;
    private Bounds bounds;

    QrPreviewSurface(WebView webView, int restoreColor, Bounds bounds, Runnable onLayout) {
        this.webView = webView;
        this.restoreColor = restoreColor;
        this.bounds = bounds;
        parent = (ViewGroup) webView.getParent();
        container = new FrameLayout(webView.getContext());
        view = new PreviewView(webView.getContext());
        view.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        view.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        view.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> onLayout.run());
        container.addView(view);
        viewportLayout = (v, l, t, r, b, ol, ot, or, ob) -> {
            layout();
            onLayout.run();
        };
        webView.addOnLayoutChangeListener(viewportLayout);
        container.addOnLayoutChangeListener(viewportLayout);
        parent.addView(container, parent.indexOfChild(webView), new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.setBackgroundColor(Color.TRANSPARENT);
        layout();
    }

    void update(Bounds bounds) {
        this.bounds = bounds;
        layout();
    }

    boolean hasEmptyBounds() {
        if (webView.getWidth() == 0 || webView.getHeight() == 0) {
            return false;
        }
        Pixels pixels = bounds.toPixels(webView.getWidth(), webView.getHeight());
        return pixels.width() == 0 || pixels.height() == 0;
    }

    Viewport viewport() {
        if (view.isLayoutRequested() || view.getWidth() == 0 || view.getHeight() == 0 || view.getDisplay() == null) {
            return null;
        }
        return new Viewport(view.getWidth(), view.getHeight(), view.getDisplay().getRotation(), view.getLayoutDirection());
    }

    private void layout() {
        int[] origin = new int[2];
        int[] containerOrigin = new int[2];
        webView.getLocationInWindow(origin);
        container.getLocationInWindow(containerOrigin);
        Pixels pixels = bounds.toPixels(webView.getWidth(), webView.getHeight());
        int left = origin[0] - containerOrigin[0] + pixels.left();
        int top = origin[1] - containerOrigin[1] + pixels.top();
        FrameLayout.LayoutParams current = (FrameLayout.LayoutParams) view.getLayoutParams();
        if (current.width == pixels.width() && current.height == pixels.height()
            && current.leftMargin == left && current.topMargin == top) {
            return;
        }

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(pixels.width(), pixels.height(), Gravity.TOP | Gravity.LEFT);
        params.leftMargin = left;
        params.topMargin = top;
        view.setLayoutParams(params);
    }

    void hide() {
        container.setAlpha(0);
        webView.setBackgroundColor(restoreColor);
    }

    void close() {
        hide();
        webView.removeOnLayoutChangeListener(viewportLayout);
        container.removeOnLayoutChangeListener(viewportLayout);
        parent.removeView(container);
    }

    record Bounds(double x, double y, double width, double height) {
        Bounds {
            if (!(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1)) {
                throw new IllegalArgumentException("Preview bounds must have positive area inside the WebView viewport.");
            }
        }

        Pixels toPixels(int width, int height) {
            int left = (int) Math.round(x * width);
            int top = (int) Math.round(y * height);
            return new Pixels(left, top, (int) Math.round((x + this.width) * width) - left,
                (int) Math.round((y + this.height) * height) - top);
        }
    }

    record Pixels(int left, int top, int width, int height) {}

    record Viewport(int width, int height, int rotation, int layoutDirection) {}
}
