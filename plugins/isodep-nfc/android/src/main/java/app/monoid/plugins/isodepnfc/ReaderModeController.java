package app.monoid.plugins.isodepnfc;

/** Owns discovery metadata for a scan, including tags without an active connection. */
final class ReaderModeController<T> implements SessionController.Reader {
    interface TagCallback<T> {
        void accept(T tag);
    }

    interface Platform<T> {
        void enable(TagCallback<T> onTag);
        SessionController.Transport transport(T tag);
        void ignore(T tag);
        void disable();
    }

    private static final class Discovery<T> {
        T lastTag;
    }

    private final Platform<T> platform;
    private Discovery<T> discovery;

    ReaderModeController(Platform<T> platform) {
        this.platform = platform;
    }

    @Override
    public void start(SessionController.TagCallback onTag) {
        Discovery<T> current = new Discovery<>();
        synchronized (this) {
            discovery = current;
        }
        platform.enable(tag -> {
            synchronized (this) {
                if (discovery != current) {
                    return;
                }
                // Retain even a tag that the session controller cannot accept
                // while busy: it may have replaced the previous native handle.
                current.lastTag = tag;
            }
            SessionController.Transport transport = platform.transport(tag);
            if (transport != null) {
                onTag.accept(transport);
            }
        });
    }

    @Override
    public void stop() {
        T lastTag;
        synchronized (this) {
            if (discovery == null) {
                return;
            }
            lastTag = discovery.lastTag;
            discovery = null;
        }
        // SessionController has finished all connect/exchange/close work before
        // entering here. ignore invalidates the tag, so no transport may use it
        // afterward. Suppress dispatch before restoring normal system polling.
        try {
            if (lastTag != null) {
                platform.ignore(lastTag);
            }
        } finally {
            platform.disable();
        }
    }
}
