package app.monoid.plugins.isodepnfc;

/** Owns discovery metadata for a scan, including tags without an active connection. */
final class ReaderModeController<T> implements SessionController.Reader {
    interface TagCallback<T> {
        void accept(T tag);
    }

    interface Platform<T> {
        void enable(TagCallback<T> onTag);
        SessionController.Transport transport(T tag);
        void waitForRemoval(T tag, Runnable removed) throws SessionController.TransportException;
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
    public void waitForRemoval(SessionController.Result<Void> result) {
        Discovery<T> current;
        T tag;
        synchronized (this) {
            current = discovery;
            tag = current == null ? null : current.lastTag;
        }
        if (tag == null) {
            result.reject(new SessionController.Failure("SESSION_CLOSED",
                "The NFC tag is no longer available for removal detection.", null, null));
            return;
        }
        try {
            platform.waitForRemoval(tag, () -> {
                synchronized (this) {
                    if (discovery != current) {
                        return;
                    }
                }
                result.resolve(null);
            });
        } catch (SessionController.TransportException exception) {
            String message = exception.code.equals("UNSUPPORTED")
                ? "Waiting for card removal requires Android 7 or later."
                : "Android could not confirm card removal. Remove the card before scanning again.";
            result.reject(new SessionController.Failure(exception.code, message, null, null));
        } catch (RuntimeException exception) {
            result.reject(new SessionController.Failure("IO_ERROR",
                "Unable to monitor NFC card removal.", null, null));
        }
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
