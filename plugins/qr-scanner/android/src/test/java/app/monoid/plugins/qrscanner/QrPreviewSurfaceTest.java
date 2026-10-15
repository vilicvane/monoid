package app.monoid.plugins.qrscanner;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewPropertyAnimator;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.camera.view.PreviewView;
import org.junit.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedConstruction;

public class QrPreviewSurfaceTest {
    private static final int BACKGROUND = Color.WHITE;
    private static final QrPreviewSurface.Bounds BOUNDS = new QrPreviewSurface.Bounds(0, 0, 1, 1);

    @Test
    public void hidePreservesTheBackingWhileRestoringTheWebViewBackground() {
        try (Fixture fixture = new Fixture()) {
            QrPreviewSurface surface = fixture.open();
            FrameLayout container = fixture.containers.constructed().get(0);

            surface.hide();

            verify(surface.view).setVisibility(View.INVISIBLE);
            verify(fixture.webView).setBackgroundColor(BACKGROUND);
            verify(container).setBackgroundColor(BACKGROUND);
            verify(container, never()).setAlpha(anyFloat());
            verify(container, never()).setVisibility(anyInt());
            verify(fixture.parent, never()).removeView(container);
        }
    }

    @Test
    public void closeReleasesThePreviewBeforeTheWebViewIsReadyToDraw() {
        try (Fixture fixture = new Fixture()) {
            QrPreviewSurface surface = fixture.open();
            FrameLayout container = fixture.containers.constructed().get(0);

            surface.close();

            verify(container).removeView(surface.view);
            verify(fixture.webView).removeOnLayoutChangeListener(any());
            verify(container).removeOnLayoutChangeListener(any());
            verify(fixture.parent, never()).removeView(container);

            fixture.visualCallback().onComplete(0);

            var order = inOrder(fixture.webView, fixture.parent);
            order.verify(fixture.webView).invalidate();
            order.verify(fixture.parent).removeView(container);
            verify(fixture.webView).removeOnAttachStateChangeListener(any());
        }
    }

    @Test
    public void detachingTheWebViewRemovesThePendingBacking() {
        try (Fixture fixture = new Fixture()) {
            QrPreviewSurface surface = fixture.open();
            FrameLayout container = fixture.containers.constructed().get(0);
            surface.close();
            ArgumentCaptor<View.OnAttachStateChangeListener> attachment =
                ArgumentCaptor.forClass(View.OnAttachStateChangeListener.class);
            verify(fixture.webView).addOnAttachStateChangeListener(attachment.capture());

            attachment.getValue().onViewDetachedFromWindow(fixture.webView);

            verify(fixture.parent).removeView(container);
            verify(fixture.webView).removeOnAttachStateChangeListener(attachment.getValue());
        }
    }

    @Test
    public void anAlreadyDetachedWebViewDoesNotWaitForAVisualCallback() {
        try (Fixture fixture = new Fixture()) {
            QrPreviewSurface surface = fixture.open();
            FrameLayout container = fixture.containers.constructed().get(0);
            when(fixture.webView.isAttachedToWindow()).thenReturn(false);

            surface.close();

            verify(container).removeView(surface.view);
            verify(fixture.parent).removeView(container);
            verify(fixture.webView, never()).postVisualStateCallback(anyLong(), any());
            verify(fixture.webView, never()).addOnAttachStateChangeListener(any());
        }
    }

    @Test
    public void anOldVisualCallbackDoesNotAffectTheNextCameraSession() {
        try (Fixture fixture = new Fixture()) {
            QrPreviewSurface first = fixture.open();
            FrameLayout firstContainer = fixture.containers.constructed().get(0);
            first.close();
            WebView.VisualStateCallback callback = fixture.visualCallback();

            QrPreviewSurface next = fixture.open();
            FrameLayout nextContainer = fixture.containers.constructed().get(1);
            clearInvocations(fixture.webView, fixture.parent, nextContainer, next.view);

            callback.onComplete(0);

            verify(fixture.parent).removeView(firstContainer);
            verify(fixture.parent, never()).removeView(nextContainer);
            verify(fixture.webView, never()).setBackgroundColor(anyInt());
            verifyNoInteractions(nextContainer, next.view);
        }
    }

    private static final class Fixture implements AutoCloseable {
        final WebView webView = mock(WebView.class);
        final ViewGroup parent = mock(ViewGroup.class);
        final MockedConstruction<FrameLayout> containers = mockConstruction(FrameLayout.class);
        final MockedConstruction<PreviewView> previews = mockConstruction(PreviewView.class, (view, context) -> {
            when(view.animate()).thenReturn(mock(ViewPropertyAnimator.class));
            when(view.getLayoutParams()).thenReturn(mock(FrameLayout.LayoutParams.class));
        });
        final MockedConstruction<ViewGroup.LayoutParams> layouts = mockConstruction(ViewGroup.LayoutParams.class);

        Fixture() {
            when(webView.getParent()).thenReturn(parent);
            when(webView.isAttachedToWindow()).thenReturn(true);
        }

        QrPreviewSurface open() {
            return new QrPreviewSurface(webView, BACKGROUND, BOUNDS, () -> {});
        }

        WebView.VisualStateCallback visualCallback() {
            ArgumentCaptor<WebView.VisualStateCallback> callback =
                ArgumentCaptor.forClass(WebView.VisualStateCallback.class);
            verify(webView).postVisualStateCallback(eq(0L), callback.capture());
            return callback.getValue();
        }

        @Override
        public void close() {
            layouts.close();
            previews.close();
            containers.close();
        }
    }
}
