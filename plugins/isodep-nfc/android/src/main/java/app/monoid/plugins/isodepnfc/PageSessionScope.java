package app.monoid.plugins.isodepnfc;

import java.util.concurrent.Executor;

/** Keeps queued bridge calls and native results owned by their WebView document. */
final class PageSessionScope {
    private final SessionController sessions;
    private final Executor main;
    private final Executor bridge;
    // Only dispatch and the bridge barrier access bridgeDocument, on Capacitor's queue.
    private Object bridgeDocument = new Object();
    // All other state is confined to the main thread.
    private Object document = bridgeDocument;
    private boolean destroyed;

    PageSessionScope(SessionController sessions, Executor main, Executor bridge) {
        this.sessions = sessions;
        this.main = main;
        this.bridge = bridge;
    }

    void dispatch(Runnable action) {
        Object source = bridgeDocument;
        main.execute(() -> {
            if (isCurrent(source)) {
                action.run();
            }
        });
    }

    Object currentDocument() {
        return document;
    }

    boolean isCurrent(Object source) {
        return !destroyed && document == source;
    }

    <T> SessionController.Result<T> bind(SessionController.Result<T> result) {
        Object source = document;
        return new SessionController.Result<T>() {
            @Override
            public void resolve(T value) {
                if (isCurrent(source)) {
                    result.resolve(value);
                }
            }

            @Override
            public void reject(SessionController.Failure failure) {
                if (isCurrent(source)) {
                    result.reject(failure);
                }
            }
        };
    }

    void pageStarted() {
        if (destroyed) {
            return;
        }
        // Initial page load also arrives here, with no scan to terminate. Retire
        // the document before termination can settle any old PluginCall.
        document = new Object();
        sessions.terminate("page-reloaded", "APP_INACTIVE");
        Object next = document;
        // Old calls already queued on Capacitor's worker must keep their old
        // document even if they have not yet dispatched to the main thread.
        bridge.execute(() -> bridgeDocument = next);
    }

    void destroy() {
        destroyed = true;
        sessions.terminate("destroyed", "APP_INACTIVE");
    }
}
