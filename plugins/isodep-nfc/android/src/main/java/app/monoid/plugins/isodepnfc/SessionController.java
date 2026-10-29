package app.monoid.plugins.isodepnfc;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;

/** State transitions run on the control executor; blocking NFC calls never do. */
final class SessionController {
    private static final int CONNECT_TIMEOUT_MS = 30_000;

    interface Result<T> {
        void resolve(T value);
        void reject(Failure failure);
    }

    interface Scheduler {
        Runnable schedule(int delayMs, Runnable action);
    }

    interface Reader {
        void start(TagCallback onTag);
        void waitForRemoval(Result<Void> result);
        void tagRemoved(Transport transport);
        void linger();
        void stop();
    }

    interface TagCallback {
        void accept(Transport transport);

        default void acceptRetained(Transport transport, Runnable discard) {
            accept(transport);
        }
    }

    interface Transport {
        void connect() throws TransportException;
        TagInfo info();
        void setTimeout(int timeoutMs);
        byte[] transceive(byte[] data) throws TransportException;
        void close() throws TransportException;
    }

    interface Listener {
        void opened(String scanId, String sessionId, TagInfo tag);
        void ended(String scanId, String sessionId, String reason, String code);
        void scanEnded(String scanId, String reason, String code);
    }

    static final class TagInfo {
        final byte[] identifier;
        final int maxTransceiveLength;
        final boolean adapterSupportsExtendedLengthApdu;

        TagInfo(byte[] identifier, int maxTransceiveLength, boolean extendedLength) {
            this.identifier = identifier == null ? null : identifier.clone();
            this.maxTransceiveLength = maxTransceiveLength;
            this.adapterSupportsExtendedLengthApdu = extendedLength;
        }
    }

    static final class Failure {
        final String code;
        final String message;
        final String operation;
        final String outcome;

        Failure(String code, String message, String operation, String outcome) {
            this.code = code;
            this.message = message;
            this.operation = operation;
            this.outcome = outcome;
        }
    }

    static final class TransportException extends Exception {
        final String code;

        TransportException(String code) {
            super(code);
            this.code = code;
        }
    }

    private static final class Scan {
        final String id;
        final int timeoutMs;
        final List<Result<Void>> stopping = new ArrayList<>();
        // The reader callback may run off the control thread. Reserve one tag
        // before posting it, so discoveries received while busy cannot queue up.
        boolean acceptingTags = true;
        boolean stopped;
        boolean finishing;
        boolean closeFailed;
        boolean fullStop;
        String endCode;
        String removedSessionId;
        // Discovery callbacks reserve these under this scan's monitor.
        Probe probe;
        Transport freshTag;

        Scan(String id, int timeoutMs) {
            this.id = id;
            this.timeoutMs = timeoutMs;
        }
    }

    /** A retained handle is not a session until its presence probe succeeds. */
    private static final class Probe {
        final Scan scan;
        final Transport transport;
        final Runnable discard;
        // cancelled is shared with the I/O worker under the probe monitor.
        boolean cancelled;
        boolean working;
        boolean closingTransport;
        boolean started;
        boolean present;
        boolean timedOut;
        Runnable cancelTimeout;

        Probe(Scan scan, Transport transport, Runnable discard) {
            this.scan = scan;
            this.transport = transport;
            this.discard = discard;
        }
    }

    private static final class Exchange {
        final Result<byte[]> result;
        // Protected by the session monitor, together with ended.
        boolean sent;
        Runnable cancelTimeout;

        Exchange(Result<byte[]> result) {
            this.result = result;
        }
    }

    private static final class Session {
        final String id = UUID.randomUUID().toString();
        final Scan scan;
        final Transport transport;
        final List<Result<Void>> closing = new ArrayList<>();
        final List<Result<Void>> removing = new ArrayList<>();
        TagInfo tag;
        Exchange exchange;
        Runnable cancelConnectTimeout;
        // Only ended and Exchange.sent are shared with the I/O worker.
        boolean ended;
        boolean working;
        boolean closingTransport;
        boolean closeFailed;
        boolean closeRequested;
        boolean waitingForRemoval;
        boolean removalStarted;
        boolean removed;
        Failure removalFailure;

        Session(Scan scan, Transport transport) {
            this.scan = scan;
            this.transport = transport;
        }
    }

    private final Reader reader;
    private final Executor control;
    private final Executor io;
    private final Executor closer;
    private final Scheduler scheduler;
    private final Listener listener;
    private final Set<String> retiredScanIds = new HashSet<>();
    private Scan scanning;
    private Session active;

    SessionController(Reader reader, Executor control, Executor io, Executor closer,
                      Scheduler scheduler, Listener listener) {
        this.reader = reader;
        this.control = control;
        this.io = io;
        this.closer = closer;
        this.scheduler = scheduler;
        this.listener = listener;
    }

    void startScan(String id, int transceiveTimeoutMs, Result<Void> result) {
        if (retiredScanIds.contains(id)) {
            result.reject(failure("SCAN_CLOSED", "This scan ID has already ended.", "startScan", null));
            return;
        }
        if (scanning != null) {
            result.reject(failure("BUSY", "Scanning is already active or stopping.", "startScan", null));
            return;
        }

        Scan scan = new Scan(id, transceiveTimeoutMs);
        scanning = scan;
        try {
            reader.start(new TagCallback() {
                @Override
                public void accept(Transport transport) {
                    synchronized (scan) {
                        if (!scan.acceptingTags) {
                            return;
                        }
                        scan.acceptingTags = false;
                        scan.freshTag = transport;
                    }
                    control.execute(() -> advanceDiscovery(scan));
                }

                @Override
                public void acceptRetained(Transport transport, Runnable discard) {
                    synchronized (scan) {
                        if (!scan.acceptingTags || scan.probe != null) {
                            return;
                        }
                        scan.probe = new Probe(scan, transport, discard);
                    }
                    control.execute(() -> advanceDiscovery(scan));
                }
            });
            result.resolve(null);
        } catch (RuntimeException error) {
            endScan(scan, "io-error", "IO_ERROR");
            result.reject(failure("IO_ERROR", "Unable to start NFC scanning.", "startScan", null));
        }
    }

    private void advanceDiscovery(Scan scan) {
        Probe probe;
        Transport freshTag;
        synchronized (scan) {
            if (scanning != scan || scan.stopped) {
                return;
            }
            probe = scan.probe;
            freshTag = scan.freshTag;
            if (probe == null) {
                scan.freshTag = null;
            }
        }
        if (probe != null) {
            if (freshTag != null) {
                // A real discovery wins, but must wait for the probe's RF work.
                cancelProbe(probe);
            } else if (!probe.started) {
                startProbe(probe);
            }
        } else if (freshTag != null) {
            discovered(scan, freshTag);
        }
    }

    private void startProbe(Probe probe) {
        probe.started = true;
        probe.working = true;
        probe.cancelTimeout = scheduler.schedule(CONNECT_TIMEOUT_MS, () -> {
            synchronized (probe.scan) {
                if (probe.scan.probe != probe) {
                    return;
                }
            }
            if (probe.cancelled) {
                return;
            }
            probe.timedOut = true;
            cancelProbe(probe);
        });
        io.execute(() -> {
            boolean present = false;
            try {
                boolean cancelled;
                synchronized (probe) {
                    cancelled = probe.cancelled;
                }
                if (!cancelled) {
                    probe.transport.connect();
                    present = true;
                }
            } catch (TransportException | RuntimeException exception) {
                // A stale native tag is not a failed JS connection attempt.
            }
            // Also close after cancellation: connect can complete after the
            // independent close worker has already tried to interrupt it.
            boolean closed = !closeTransport(probe.transport);
            boolean available = present && closed;
            control.execute(() -> {
                probe.working = false;
                probe.present = available;
                probe.cancelTimeout.run();
                finishProbe(probe);
            });
        });
    }

    private void cancelProbe(Probe probe) {
        synchronized (probe.scan) {
            if (probe.scan.probe != probe) {
                return;
            }
        }
        synchronized (probe) {
            if (probe.cancelled) {
                return;
            }
            probe.cancelled = true;
        }
        if (!probe.started) {
            finishProbe(probe);
            return;
        }
        probe.cancelTimeout.run();
        probe.closingTransport = true;
        closer.execute(() -> {
            closeTransport(probe.transport);
            control.execute(() -> {
                probe.closingTransport = false;
                finishProbe(probe);
            });
        });
    }

    private void finishProbe(Probe probe) {
        if (probe.working || probe.closingTransport) {
            return;
        }
        Scan scan = probe.scan;
        Transport next;
        synchronized (scan) {
            if (scan.probe != probe) {
                return;
            }
            scan.probe = null;
            next = scan.freshTag;
            scan.freshTag = null;
            if (next == null && probe.present && !probe.cancelled) {
                next = probe.transport;
            }
            if (next != null) {
                scan.acceptingTags = false;
            }
        }
        // Caller/lifecycle cancellation says nothing about presence. Keep the
        // handle for the next scan (or full-stop ignore); only an actual failed
        // or timed-out probe proves that this retained candidate is unusable.
        if ((!probe.cancelled && !probe.present) || probe.timedOut) {
            probe.discard.run();
        }
        if (scan.stopped) {
            finishStopping(scan);
        } else if (next != null) {
            discovered(scan, next);
        }
    }

    private void discovered(Scan scan, Transport transport) {
        if (scanning != scan || scan.stopped) {
            return;
        }
        Session session = new Session(scan, transport);
        active = session;
        session.working = true;
        session.cancelConnectTimeout = scheduler.schedule(CONNECT_TIMEOUT_MS, () -> {
            if (session.tag == null) {
                end(session, "connect-timeout", "TIMEOUT");
            }
        });
        io.execute(() -> {
            TagInfo info = null;
            String error = null;
            try {
                if (canRun(session, null)) {
                    transport.connect();
                    info = transport.info();
                }
            } catch (TransportException exception) {
                error = exception.code;
            } catch (RuntimeException exception) {
                error = "IO_ERROR";
            }
            boolean cleanupFailed = closeAfterCancelledWork(session);
            TagInfo connectedInfo = info;
            String connectError = error;
            control.execute(() -> {
                session.working = false;
                session.closeFailed |= cleanupFailed;
                if (session.ended) {
                    finishClosing(session);
                } else if (connectError != null) {
                    end(session, reasonFor(connectError), connectError);
                } else {
                    session.cancelConnectTimeout.run();
                    session.tag = connectedInfo;
                    listener.opened(scan.id, session.id, connectedInfo);
                }
            });
        });
    }

    void transceive(String id, byte[] data, Integer timeoutMs, Result<byte[]> result) {
        Session session = active;
        if (session == null || session.ended || !session.id.equals(id)) {
            result.reject(failure("SESSION_CLOSED", "The NFC session is not open.", "transceive", "not-sent"));
            return;
        }
        if (session.tag == null || session.exchange != null) {
            result.reject(failure("BUSY", "The NFC connection is busy.", "transceive", "not-sent"));
            return;
        }
        if (data.length > session.tag.maxTransceiveLength) {
            result.reject(failure("DATA_TOO_LARGE", "Data exceeds maxTransceiveLength.", "transceive", "not-sent"));
            return;
        }

        Exchange exchange = new Exchange(result);
        session.exchange = exchange;
        session.working = true;
        int exchangeTimeout = timeoutMs == null ? session.scan.timeoutMs : timeoutMs;
        exchange.cancelTimeout = scheduler.schedule(exchangeTimeout, () -> {
            if (session.exchange == exchange) {
                end(session, "transceive-timeout", "TIMEOUT");
            }
        });
        byte[] request = data.clone();
        io.execute(() -> {
            byte[] response = null;
            String error = null;
            try {
                if (canRun(session, null)) {
                    session.transport.setTimeout(exchangeTimeout);
                    if (canRun(session, exchange)) {
                        response = session.transport.transceive(request);
                    }
                }
            } catch (TransportException exception) {
                error = exception.code;
            } catch (RuntimeException exception) {
                error = "IO_ERROR";
            }
            boolean cleanupFailed = closeAfterCancelledWork(session);
            byte[] received = response;
            String exchangeError = error;
            control.execute(() -> {
                session.working = false;
                session.closeFailed |= cleanupFailed;
                if (session.ended) {
                    finishClosing(session);
                } else if (exchangeError != null) {
                    end(session, reasonFor(exchangeError), exchangeError);
                } else {
                    exchange.cancelTimeout.run();
                    session.exchange = null;
                    exchange.result.resolve(received);
                }
            });
        });
    }

    private boolean canRun(Session session, Exchange exchange) {
        synchronized (session) {
            if (session.ended) {
                return false;
            }
            if (exchange != null) {
                exchange.sent = true;
            }
            return true;
        }
    }

    private boolean closeAfterCancelledWork(Session session) {
        synchronized (session) {
            if (!session.ended) {
                return false;
            }
        }
        // Cancellation can race the instant connect enters the platform. Close
        // again after work returns so a late successful connect cannot survive.
        return closeTransport(session.transport);
    }

    void close(String id, Result<Void> result) {
        close(id, false, result);
    }

    void close(String id, boolean waitForRemoval, Result<Void> result) {
        Session session = active;
        if (session == null || !session.id.equals(id)) {
            if (waitForRemoval && (scanning == null || !id.equals(scanning.removedSessionId))) {
                result.reject(failure("SESSION_CLOSED", "This session is no longer available for removal detection.", null, null));
            } else {
                result.resolve(null);
            }
            return;
        }
        session.closeRequested = true;
        if (waitForRemoval) {
            session.waitingForRemoval = true;
            session.removing.add(result);
        } else {
            session.closing.add(result);
        }
        if (session.ended) {
            finishClosing(session);
        } else {
            end(session, "closed", "CANCELLED");
        }
    }

    void stopScan(String id, Result<Void> result) {
        retiredScanIds.add(id);
        Scan scan = scanning;
        if (scan == null || !scan.id.equals(id)) {
            result.resolve(null);
            return;
        }
        scan.stopping.add(result);
        if (scan.stopped) {
            finishStopping(scan);
        } else {
            endScan(scan, "stopped", "CANCELLED");
        }
    }

    void terminate(String reason, String code) {
        if (scanning != null) {
            // Lifecycle termination can overtake an ordinary stop's cleanup.
            scanning.fullStop = true;
            endScan(scanning, reason, code);
        } else {
            try {
                reader.stop();
            } catch (RuntimeException exception) {
                // There is no live call to reject. Reader.stop clears its
                // state even if Android's lifecycle cleanup throws.
            }
        }
    }

    private void endScan(Scan scan, String reason, String code) {
        if (scanning != scan || scan.stopped) {
            return;
        }
        synchronized (scan) {
            scan.acceptingTags = false;
            scan.stopped = true;
        }
        scan.fullStop |= !reason.equals("stopped");
        scan.endCode = code;
        retiredScanIds.add(scan.id);
        if (active != null) {
            end(active, reason.equals("stopped") ? "scan-stopped" : reason, code);
        }
        listener.scanEnded(scan.id, reason, code.equals("CANCELLED") ? null : code);
        if (scan.probe != null) {
            cancelProbe(scan.probe);
        }
        if (active != null) {
            finishClosing(active);
        }
        finishStopping(scan);
    }

    private void end(Session session, String reason, String code) {
        if (active != session || session.ended) {
            return;
        }
        String outcome;
        synchronized (session) {
            session.ended = true;
            session.removed = code.equals("TAG_LOST");
            outcome = session.exchange != null && session.exchange.sent ? "unknown" : "not-sent";
        }
        if (session.removed) {
            reader.tagRemoved(session.transport);
        }
        session.closingTransport = true;
        session.cancelConnectTimeout.run();
        if (session.exchange != null) {
            Exchange exchange = session.exchange;
            session.exchange = null;
            exchange.cancelTimeout.run();
            exchange.result.reject(failure(code, "The NFC session ended: " + reason + ".", "transceive", outcome));
        }
        listener.ended(session.scan.id, session.id, reason, code.equals("CANCELLED") ? null : code);
        closer.execute(() -> {
            boolean failed = closeTransport(session.transport);
            control.execute(() -> {
                session.closingTransport = false;
                session.closeFailed |= failed;
                finishClosing(session);
            });
        });
    }

    private static boolean closeTransport(Transport transport) {
        // Only the two close paths share this monitor. Blocking connect and
        // transceive never hold it, so close can interrupt them independently.
        synchronized (transport) {
            try {
                transport.close();
                return false;
            } catch (TransportException | RuntimeException exception) {
                return true;
            }
        }
    }

    private void finishClosing(Session session) {
        if (!session.ended || session.working || session.closingTransport) {
            return;
        }
        Scan scan = session.scan;
        scan.closeFailed |= session.closeFailed;
        if (session.closeFailed && !scan.stopped) {
            // Do not accept another tag if the old connection failed to close.
            endScan(scan, "io-error", "IO_ERROR");
            return;
        }
        List<Result<Void>> closing = new ArrayList<>(session.closing);
        session.closing.clear();
        for (Result<Void> result : closing) {
            settleCleanup(result, session.closeFailed);
        }

        if (session.waitingForRemoval && !session.removed && !scan.stopped) {
            if (!session.removalStarted) {
                session.removalStarted = true;
                reader.waitForRemoval(new Result<Void>() {
                    @Override
                    public void resolve(Void value) {
                        control.execute(() -> removalFinished(session, null));
                    }

                    @Override
                    public void reject(Failure failure) {
                        control.execute(() -> removalFinished(session, failure));
                    }
                });
            }
            return;
        }
        // Failed sessions remain reserved until their caller chooses whether
        // cleanup alone or detected removal should release discovery.
        if (!scan.stopped && !session.closeRequested) {
            return;
        }
        if (active == session) {
            active = null;
        }
        if (!scan.stopped) {
            if (session.removed) {
                scan.removedSessionId = session.id;
            }
            synchronized (scan) {
                scan.acceptingTags = true;
            }
        }
        List<Result<Void>> removing = new ArrayList<>(session.removing);
        session.removing.clear();
        for (Result<Void> result : removing) {
            if (session.removalFailure != null) {
                result.reject(session.removalFailure);
            } else if (scan.stopped) {
                result.reject(failure(scan.endCode, "The NFC scan ended while waiting for card removal.", null, null));
            } else {
                result.resolve(null);
            }
        }
        finishStopping(scan);
    }

    private void removalFinished(Session session, Failure failure) {
        if (active != session || session.scan.stopped || session.removed) {
            return;
        }
        if (failure != null) {
            session.removalFailure = failure;
            endScan(session.scan, "io-error", failure.code);
        } else {
            session.removed = true;
            finishClosing(session);
        }
    }

    private void finishStopping(Scan scan) {
        if (!scan.stopped || scan.finishing || scan.probe != null || (active != null && active.scan == scan)) {
            return;
        }
        scan.finishing = true;
        // Ordinary stops retain reader ownership only after all transport and
        // probe work has exited. Lifecycle stops and cleanup failures release it.
        try {
            if (scan.fullStop || scan.closeFailed) {
                reader.stop();
            } else {
                reader.linger();
            }
        } catch (RuntimeException exception) {
            scan.closeFailed = true;
            try {
                reader.stop();
            } catch (RuntimeException ignored) {
                // Preserve the original cleanup failure after clearing ownership.
            }
        }
        if (scanning == scan) {
            scanning = null;
        }
        List<Result<Void>> stopping = new ArrayList<>(scan.stopping);
        scan.stopping.clear();
        for (Result<Void> result : stopping) {
            settleCleanup(result, scan.closeFailed);
        }
    }

    private static void settleCleanup(Result<Void> result, boolean failed) {
        if (failed) {
            result.reject(failure("IO_ERROR", "The platform could not cleanly close NFC.", null, null));
        } else {
            result.resolve(null);
        }
    }

    private static String reasonFor(String code) {
        return code.equals("TAG_LOST") ? "tag-lost" : "io-error";
    }

    private static Failure failure(String code, String message, String operation, String outcome) {
        return new Failure(code, message, operation, outcome);
    }
}
