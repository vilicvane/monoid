package app.monoid.plugins.isodepnfc;

/**
 * Owns Reader Mode across scans, including a bounded idle linger between scans.
 * Lifecycle methods and timers run on the control thread; discovery may not.
 */
final class ReaderModeController<T> implements SessionController.Reader {
    static final int LINGER_TIMEOUT_MS = 5 * 60 * 1_000;

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
        SessionController.Transport lastTransport;
        Object tagVersion;
        SessionController.TagCallback onTag;
        Object removal;
        Object linger;
        Runnable cancelLinger;
    }

    private final Platform<T> platform;
    private final SessionController.Scheduler scheduler;
    private Discovery<T> discovery;

    ReaderModeController(Platform<T> platform, SessionController.Scheduler scheduler) {
        this.platform = platform;
        this.scheduler = scheduler;
    }

    @Override
    public void start(SessionController.TagCallback onTag) {
        Discovery<T> current;
        synchronized (this) {
            if (discovery != null) {
                current = discovery;
                cancelLinger(current);
                current.removal = null;
                current.onTag = onTag;
                if (current.lastTransport != null) {
                    Object version = current.tagVersion;
                    onTag.acceptRetained(current.lastTransport, () -> dropTag(current, version));
                }
                return;
            }
            current = new Discovery<>();
            current.onTag = onTag;
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
                current.tagVersion = new Object();
                current.lastTransport = null;
                try {
                    current.lastTransport = platform.transport(tag);
                } catch (RuntimeException exception) {
                    // No session exists for this unusable discovery.
                    return;
                }
                if (current.onTag != null && current.lastTransport != null) {
                    // Capture/deliver under the same monitor as start/linger so
                    // a late callback cannot migrate into a different scan.
                    current.onTag.accept(current.lastTransport);
                }
            }
        });
    }

    private synchronized void dropTag(Discovery<T> current, Object version) {
        if (discovery == current && current.tagVersion == version) {
            current.lastTag = null;
            current.lastTransport = null;
            current.tagVersion = null;
        }
    }

    @Override
    public synchronized void tagRemoved(SessionController.Transport transport) {
        if (discovery != null && discovery.lastTransport == transport) {
            dropTag(discovery, discovery.tagVersion);
        }
    }

    @Override
    public void waitForRemoval(SessionController.Result<Void> result) {
        Discovery<T> current;
        T tag;
        Object version;
        Object removal = new Object();
        synchronized (this) {
            current = discovery;
            tag = current == null ? null : current.lastTag;
            version = current == null ? null : current.tagVersion;
            if (current != null) {
                current.removal = removal;
            }
        }
        if (tag == null) {
            result.reject(new SessionController.Failure("SESSION_CLOSED",
                "The NFC tag is no longer available for removal detection.", null, null));
            return;
        }
        try {
            platform.waitForRemoval(tag, () -> {
                synchronized (this) {
                    if (discovery != current || current.removal != removal) {
                        return;
                    }
                    current.removal = null;
                    dropTag(current, version);
                    result.resolve(null);
                }
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
    public synchronized void linger() {
        Discovery<T> current = discovery;
        if (current == null || current.linger != null) {
            return;
        }
        current.onTag = null;
        current.removal = null;
        Object linger = new Object();
        current.linger = linger;
        current.cancelLinger = scheduler.schedule(LINGER_TIMEOUT_MS, () -> {
            synchronized (this) {
                if (discovery != current || current.linger != linger) {
                    return;
                }
                try {
                    stop();
                } catch (RuntimeException exception) {
                    // No call is waiting on idle expiry. stop has already
                    // cleared ownership and attempted disable in its finally.
                }
            }
        });
    }

    private void cancelLinger(Discovery<T> current) {
        current.linger = null;
        if (current.cancelLinger != null) {
            current.cancelLinger.run();
            current.cancelLinger = null;
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
            cancelLinger(discovery);
            discovery = null;
        }
        // SessionController has finished all connect/exchange/close work before
        // entering here. Ordinary stopScan uses linger instead: ignore would
        // suppress an in-range card indefinitely, including in the next scan.
        try {
            if (lastTag != null) {
                platform.ignore(lastTag);
            }
        } finally {
            platform.disable();
        }
    }
}
