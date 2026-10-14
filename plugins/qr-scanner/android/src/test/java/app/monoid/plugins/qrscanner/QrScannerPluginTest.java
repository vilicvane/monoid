package app.monoid.plugins.qrscanner;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import android.os.Handler;
import android.os.Looper;
import androidx.appcompat.app.AppCompatActivity;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.WebViewListener;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedConstruction;
import org.mockito.MockedStatic;

public class QrScannerPluginTest {
    @Test
    public void reloadDiscardsBothWorkerQueuedAndMainQueuedCalls() {
        Queue<Runnable> worker = new ArrayDeque<>();
        Queue<Runnable> main = new ArrayDeque<>();
        try (MockedStatic<Looper> looper = mockStatic(Looper.class);
             MockedConstruction<Handler> handlers = mockConstruction(Handler.class, (handler, context) -> {
                 when(handler.post(any())).thenAnswer(invocation -> main.add(invocation.getArgument(0)));
             })) {
            Bridge bridge = mock(Bridge.class);
            AppCompatActivity activity = mock(AppCompatActivity.class);
            Lifecycle lifecycle = mock(Lifecycle.class);
            when(bridge.getActivity()).thenReturn(activity);
            when(activity.getLifecycle()).thenReturn(lifecycle);
            when(lifecycle.getCurrentState()).thenReturn(Lifecycle.State.RESUMED);
            doAnswer(invocation -> worker.add(invocation.getArgument(0))).when(bridge).execute(any());
            QrScannerPlugin plugin = new QrScannerPlugin();
            plugin.setBridge(bridge);
            plugin.load();
            drain(main);
            ArgumentCaptor<WebViewListener> listener = ArgumentCaptor.forClass(WebViewListener.class);
            verify(bridge).addWebViewListener(listener.capture());

            PluginCall mainQueued = mock(PluginCall.class);
            PluginCall workerQueued = mock(PluginCall.class);
            PluginCall intermediateDocument = mock(PluginCall.class);
            PluginCall currentDocument = mock(PluginCall.class);
            when(currentDocument.getData()).thenReturn(mock(JSObject.class));

            plugin.stopScan(mainQueued);
            worker.add(() -> plugin.stopScan(workerQueued));
            listener.getValue().onPageStarted(null);
            worker.add(() -> plugin.stopScan(intermediateDocument));
            listener.getValue().onPageStarted(null);
            worker.add(() -> plugin.stopScan(currentDocument));
            drain(worker);
            drain(main);

            verifyNoInteractions(mainQueued, workerQueued, intermediateDocument);
            verify(currentDocument).reject("scanId must be a nonblank string.", "INVALID_ARGUMENT");
        }
    }

    @Test
    public void listenerRegistersAfterBuilderReplacesItsListAndCleansUpOnReload() {
        Queue<Runnable> main = new ArrayDeque<>();
        AtomicReference<List<WebViewListener>> listeners = new AtomicReference<>(new ArrayList<>());
        try (MockedStatic<Looper> looper = mockStatic(Looper.class);
             MockedConstruction<Handler> handlers = mockConstruction(Handler.class, (handler, context) -> {
                 when(handler.post(any())).thenAnswer(invocation -> main.add(invocation.getArgument(0)));
             });
             MockedConstruction<QrScanController> controllers = mockConstruction(QrScanController.class)) {
            Bridge bridge = mock(Bridge.class);
            AppCompatActivity activity = mock(AppCompatActivity.class);
            Lifecycle lifecycle = mock(Lifecycle.class);
            when(bridge.getActivity()).thenReturn(activity);
            when(activity.getLifecycle()).thenReturn(lifecycle);
            when(lifecycle.getCurrentState()).thenReturn(Lifecycle.State.RESUMED);
            doAnswer(invocation -> listeners.get().add(invocation.getArgument(0)))
                .when(bridge).addWebViewListener(any());
            QrScannerPlugin plugin = new QrScannerPlugin();
            plugin.setBridge(bridge);
            plugin.load();

            // Bridge.Builder.create replaces the list after the constructor loads plugins.
            listeners.set(new ArrayList<>());
            drain(main);
            assertEquals(1, listeners.get().size());
            listeners.get().get(0).onPageStarted(null);
            verify(controllers.constructed().get(0)).reset();
        }
    }

    @Test
    public void destroyedPluginDoesNotRegisterItsDeferredListener() {
        Queue<Runnable> main = new ArrayDeque<>();
        try (MockedStatic<Looper> looper = mockStatic(Looper.class);
             MockedConstruction<Handler> handlers = mockConstruction(Handler.class, (handler, context) -> {
                 when(handler.post(any())).thenAnswer(invocation -> main.add(invocation.getArgument(0)));
             })) {
            Bridge bridge = mock(Bridge.class);
            AppCompatActivity activity = mock(AppCompatActivity.class);
            Lifecycle lifecycle = mock(Lifecycle.class);
            when(bridge.getActivity()).thenReturn(activity);
            when(activity.getLifecycle()).thenReturn(lifecycle);
            when(lifecycle.getCurrentState()).thenReturn(Lifecycle.State.RESUMED);
            QrScannerPlugin plugin = new QrScannerPlugin();
            plugin.setBridge(bridge);
            plugin.load();
            plugin.handleOnDestroy();
            drain(main);
            verify(bridge, never()).addWebViewListener(any());
        }
    }

    private static void drain(Queue<Runnable> queue) {
        while (!queue.isEmpty()) {
            queue.remove().run();
        }
    }
}
