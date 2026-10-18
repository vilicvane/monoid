package app.monoid.plugins.biometricvault;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executor;

/** Entry points and queue transitions run on the control executor (Android's main thread). */
final class VaultController {
    interface Store {
        Prepared prepareSet(String id, String value) throws VaultException;
        Prepared prepareGet(String id) throws VaultException;
        void remove(String id, CommitGate gate) throws VaultException;
        void clear() throws VaultException;
    }

    interface Prepared extends AutoCloseable {
        String complete(CommitGate gate) throws VaultException;
        @Override void close();
    }

    interface CommitAction { void run() throws VaultException; }
    interface CommitGate { void commit(CommitAction action) throws VaultException; }
    interface Result {
        void resolve(String value);
        void reject(VaultException error);
    }
    interface AuthenticationCallback {
        void authenticated();
        void failed(VaultException error);
    }
    interface Authentication { void cancel(); }
    interface Clock { long elapsedRealtime(); }
    interface Authenticator {
        Authentication authenticate(String reason, AuthenticationCallback callback) throws VaultException;
    }

    private final Store store;
    private final Authenticator authenticator;
    private final Executor control;
    private final Executor worker;
    private final Clock clock;
    // The worker's short commit and control-thread revocation share this lock. Cryptography and
    // fsync remain outside it, so cancellation can win until the actual file mutation starts.
    private final Object authorizationLock = new Object();
    private final Map<String, Access> accesses = new HashMap<>();
    private final Set<String> usedRequestIds = new HashSet<>();
    private final Deque<Request> queued = new ArrayDeque<>();
    private Request active;
    private int deliveryDepth;
    private boolean foreground;
    private boolean destroyed;
    private Runnable onDestroyed;

    VaultController(Store store, Authenticator authenticator, Executor control, Executor worker, Clock clock) {
        this.store = store;
        this.authenticator = authenticator;
        this.control = control;
        this.worker = worker;
        this.clock = clock;
    }

    void authenticate(String requestId, String reason, Result result) {
        enqueue(new Request(requestId, result, Operation.AUTHENTICATE, null, null, reason, null));
    }

    void set(String accessId, String id, String value, String requestId, Result result) {
        enqueueScoped(accessId, id, value, requestId, Operation.SET, result);
    }

    void get(String accessId, String id, String requestId, Result result) {
        enqueueScoped(accessId, id, null, requestId, Operation.GET, result);
    }

    void remove(String accessId, String id, String requestId, Result result) {
        if (accessId == null) {
            enqueue(new Request(null, result, Operation.REMOVE, id, null, null, null));
        } else {
            enqueueScoped(accessId, id, null, requestId, Operation.REMOVE, result);
        }
    }

    void clear(Result result) {
        enqueue(new Request(null, result, Operation.CLEAR, null, null, null, null));
    }

    private void enqueueScoped(String accessId, String id, String value, String requestId, Operation operation, Result result) {
        Access access;
        VaultException error = null;
        synchronized (authorizationLock) {
            access = accesses.get(accessId);
            try {
                checkForeground();
                checkAccess(access);
            } catch (VaultException exception) {
                error = exception;
            }
        }
        if (error != null) {
            result.reject(error);
            return;
        }
        enqueue(new Request(requestId, result, operation, id, value, null, access));
    }

    private void enqueue(Request request) {
        if (request.requestId != null && !usedRequestIds.add(request.requestId)) {
            request.result.reject(new VaultException("CANCELLED", "This request ID is no longer usable."));
            return;
        }
        boolean unavailable;
        synchronized (authorizationLock) {
            unavailable = destroyed || !foreground;
        }
        if (unavailable) {
            request.result.reject(inactive());
            return;
        }
        queued.addLast(request);
        advance();
    }

    void closeAccess(String accessId, Result result) {
        Access access;
        synchronized (authorizationLock) {
            access = accesses.remove(accessId);
            if (access == null && active != null && active.access != null && active.access.id.equals(accessId)) {
                access = active.access;
            }
            if (access != null && access.closed == null) {
                access.closed = closed();
            }
        }
        if (access == null) {
            result.resolve(null);
            return;
        }
        Access closing = access;
        Deque<Request> abandoned = new ArrayDeque<>();
        for (Iterator<Request> iterator = queued.iterator(); iterator.hasNext();) {
            Request request = iterator.next();
            if (request.access == closing) {
                abandoned.addLast(request);
                iterator.remove();
            }
        }
        deliveryDepth++;
        try {
            if (active != null && active.access == access && !active.finished) {
                access.closeWaiters.add(result);
                cancelRequest(active, closed());
            } else {
                result.resolve(null);
            }
            for (Request request : abandoned) {
                cancelRequest(request, closed());
                deliver(request, null, null);
            }
        } finally {
            deliveryDepth--;
            advance();
        }
    }

    void cancel(String requestId) {
        usedRequestIds.add(requestId);
        VaultException error = new VaultException("CANCELLED", "The operation was cancelled.");
        if (active != null && requestId.equals(active.requestId)) {
            cancelRequest(active, error);
            return;
        }
        for (Request request : queued) {
            if (requestId.equals(request.requestId)) {
                queued.remove(request);
                cancelRequest(request, error);
                deliveryDepth++;
                try {
                    deliver(request, null, null);
                } finally {
                    deliveryDepth--;
                    advance();
                }
                return;
            }
        }
    }

    void setForeground(boolean foreground) {
        synchronized (authorizationLock) {
            this.foreground = foreground;
            if (!foreground) {
                for (Access access : accesses.values()) access.closed = inactive();
                accesses.clear();
            }
        }
        if (!foreground) {
            Deque<Request> abandoned = new ArrayDeque<>(queued);
            queued.clear();
            deliveryDepth++;
            try {
                if (active != null && active.requestId != null) cancelRequest(active, inactive());
                for (Request request : abandoned) {
                    cancelRequest(request, inactive());
                    deliver(request, null, null);
                }
            } finally {
                deliveryDepth--;
                advance();
            }
        } else {
            advance();
        }
    }

    void destroy(Runnable onDestroyed) {
        synchronized (authorizationLock) {
            destroyed = true;
        }
        this.onDestroyed = onDestroyed;
        setForeground(false);
        notifyDestroyedIfIdle();
    }

    private void start(Request request) {
        try {
            synchronized (authorizationLock) {
                checkForeground();
                request.check();
            }
        } catch (VaultException error) {
            settle(request, null, error);
            return;
        }
        if (request.operation == Operation.AUTHENTICATE) {
            startAuthentication(request);
            return;
        }
        worker.execute(() -> {
            Prepared prepared = null;
            String value = null;
            VaultException error = null;
            try {
                synchronized (authorizationLock) {
                    checkForeground();
                    request.check();
                }
                switch (request.operation) {
                    case SET:
                        prepared = store.prepareSet(request.id, request.value);
                        break;
                    case GET:
                        prepared = store.prepareGet(request.id);
                        break;
                    case REMOVE:
                        store.remove(request.id, request);
                        break;
                    case CLEAR:
                        store.clear();
                        break;
                    default:
                        throw new IllegalStateException("Unexpected vault operation.");
                }
                if (prepared != null) {
                    synchronized (authorizationLock) { request.check(); }
                    value = prepared.complete(request);
                }
            } catch (VaultException exception) {
                error = exception;
            } catch (RuntimeException exception) {
                error = unexpected();
            } finally {
                if (prepared != null) closePrepared(prepared);
            }
            String completedValue = value;
            VaultException completionError = error;
            control.execute(() -> settle(request, completedValue, completionError));
        });
    }

    private void startAuthentication(Request request) {
        request.prompting = true;
        try {
            request.authentication = authenticator.authenticate(request.reason, new AuthenticationCallback() {
                @Override public void authenticated() {
                    long authenticatedAt = clock.elapsedRealtime();
                    control.execute(() -> authenticatedResult(request, authenticatedAt, null));
                }
                @Override public void failed(VaultException error) {
                    control.execute(() -> authenticatedResult(request, 0, error));
                }
            });
        } catch (VaultException error) {
            authenticatedResult(request, 0, error);
        } catch (RuntimeException error) {
            authenticatedResult(request, 0, new VaultException("AUTHENTICATION_FAILED", "Unable to start biometric authentication."));
        }
    }

    private void authenticatedResult(Request request, long authenticatedAt, VaultException error) {
        if (active != request || !request.prompting) return;
        request.prompting = false;
        request.authentication = null;
        String accessId = null;
        synchronized (authorizationLock) {
            try {
                request.check();
                if (error == null) {
                    Access access = new Access(UUID.randomUUID().toString(), authenticatedAt);
                    checkAccess(access);
                    accesses.put(access.id, access);
                    accessId = access.id;
                }
            } catch (VaultException exception) {
                error = exception;
            }
        }
        settle(request, accessId, error);
    }

    private void cancelRequest(Request request, VaultException error) {
        synchronized (authorizationLock) {
            if (request.finished || request.committed || request.cancelled != null) return;
            request.cancelled = error;
        }
        if (request.prompting && request.authentication != null) {
            // Wait for terminal prompt cancellation before the next queued authentication.
            request.authentication.cancel();
        }
    }

    private void settle(Request request, String value, VaultException error) {
        if (active != request || request.finished) return;
        deliveryDepth++;
        try {
            deliver(request, value, error);
        } finally {
            active = null;
            if (request.access != null) {
                List<Result> waiters = new ArrayList<>(request.access.closeWaiters);
                request.access.closeWaiters.clear();
                for (Result waiter : waiters) waiter.resolve(null);
            }
            deliveryDepth--;
            advance();
        }
    }

    private void deliver(Request request, String value, VaultException error) {
        synchronized (authorizationLock) {
            if (!request.committed && request.access != null && error != null && error.code().equals("AUTHORIZATION_EXPIRED")) {
                request.access.closed = error;
                accesses.remove(request.access.id);
            }
            if (!request.committed) {
                try {
                    request.check();
                } catch (VaultException exception) {
                    error = exception;
                }
            }
            request.finished = true;
        }
        if (error != null) request.result.reject(error);
        else request.result.resolve(value);
    }

    private void advance() {
        if (active == null && deliveryDepth == 0 && foreground && !destroyed && !queued.isEmpty()) {
            active = queued.removeFirst();
            start(active);
        }
        notifyDestroyedIfIdle();
    }

    private void notifyDestroyedIfIdle() {
        if (active == null && queued.isEmpty() && deliveryDepth == 0 && onDestroyed != null) {
            Runnable callback = onDestroyed;
            onDestroyed = null;
            callback.run();
        }
    }

    // Call only while holding authorizationLock.
    private void checkForeground() throws VaultException {
        if (destroyed || !foreground) throw inactive();
    }

    private void checkAccess(Access access) throws VaultException {
        if (access == null) throw closed();
        if (access.closed != null) throw access.closed;
        if (clock.elapsedRealtime() - access.authenticatedAt >= VaultKeyPolicy.AUTHENTICATION_VALIDITY_SECONDS * 1000L) {
            access.closed = new VaultException("AUTHORIZATION_EXPIRED", "Biometric authorization has expired.");
            accesses.remove(access.id);
            throw access.closed;
        }
    }

    private static VaultException inactive() {
        return new VaultException("APP_INACTIVE", "The app must be in the foreground.");
    }
    private static VaultException closed() {
        return new VaultException("ACCESS_CLOSED", "Vault access is closed or unknown.");
    }
    private static VaultException unexpected() {
        return new VaultException("IO_ERROR", "The vault operation could not be completed.");
    }
    private static void closePrepared(Prepared prepared) {
        try {
            prepared.close();
        } catch (RuntimeException ignored) {
            // Cleanup must not strand the queue or override an already committed write.
        }
    }

    private enum Operation { AUTHENTICATE, SET, GET, REMOVE, CLEAR }

    private static final class Access {
        final String id;
        final long authenticatedAt;
        final List<Result> closeWaiters = new ArrayList<>();
        VaultException closed;
        Access(String id, long authenticatedAt) {
            this.id = id;
            this.authenticatedAt = authenticatedAt;
        }
    }

    private final class Request implements CommitGate {
        final String requestId;
        final Result result;
        final Operation operation;
        final String id;
        final String value;
        final String reason;
        final Access access;
        Authentication authentication;
        boolean prompting;
        boolean finished;
        boolean committed;
        VaultException cancelled;

        Request(String requestId, Result result, Operation operation, String id, String value, String reason, Access access) {
            this.requestId = requestId;
            this.result = result;
            this.operation = operation;
            this.id = id;
            this.value = value;
            this.reason = reason;
            this.access = access;
        }

        void check() throws VaultException {
            if (committed) return;
            if (cancelled != null) throw cancelled;
            if (access != null || operation == Operation.AUTHENTICATE) checkForeground();
            if (access != null) checkAccess(access);
        }

        @Override public void commit(CommitAction action) throws VaultException {
            synchronized (authorizationLock) {
                check();
                action.run();
                committed = true;
            }
        }
    }
}
