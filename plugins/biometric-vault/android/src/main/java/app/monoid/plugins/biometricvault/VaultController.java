package app.monoid.plugins.biometricvault;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executor;
import javax.crypto.Cipher;

/** All entry points and state transitions run on the control executor (Android's main thread). */
final class VaultController {
    interface Store {
        Prepared prepareSet(String id, String value) throws VaultException;
        Prepared prepareGet(String id) throws VaultException;
        void remove(String id) throws VaultException;
        void clear() throws VaultException;
    }

    interface Prepared extends AutoCloseable {
        Cipher cipher();
        String complete(CommitGate gate) throws VaultException;
        @Override void close();
    }

    interface CommitAction {
        void run() throws VaultException;
    }

    interface CommitGate {
        void commit(CommitAction action) throws VaultException;
    }

    interface Result {
        void resolve(String value);
        void reject(VaultException error);
    }

    interface AuthenticationCallback {
        void authenticated(Cipher cipher);
        void failed(VaultException error);
    }

    interface Authentication {
        void cancel();
    }

    interface Authenticator {
        Authentication authenticate(Cipher cipher, String reason, AuthenticationCallback callback) throws VaultException;
    }

    private final Store store;
    private final Authenticator authenticator;
    private final Executor control;
    private final Executor worker;
    private final Set<String> usedRequestIds = new HashSet<>();
    private final Deque<Request> queued = new ArrayDeque<>();
    private Request active;
    private int deliveryDepth;
    private boolean foreground;
    private boolean destroyed;
    private Runnable onDestroyed;

    VaultController(Store store, Authenticator authenticator, Executor control, Executor worker) {
        this.store = store;
        this.authenticator = authenticator;
        this.control = control;
        this.worker = worker;
    }

    void setForeground(boolean foreground) {
        this.foreground = foreground;
        if (!foreground) {
            Deque<Request> abandoned = new ArrayDeque<>(queued);
            queued.clear();
            VaultException error = new VaultException("APP_INACTIVE", "The app left the foreground.");
            deliveryDepth++;
            try {
                if (active != null && active.requestId != null) {
                    cancelActive(error);
                }
                for (Request request : abandoned) {
                    request.cancel(error);
                    deliver(request, null, error);
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
        destroyed = true;
        this.onDestroyed = onDestroyed;
        setForeground(false);
        notifyDestroyedIfIdle();
    }

    void set(String id, String value, String requestId, String reason, Result result) {
        begin(id, value, requestId, reason, true, result);
    }

    void get(String id, String requestId, String reason, Result result) {
        begin(id, null, requestId, reason, false, result);
    }

    private void begin(String id, String value, String requestId, String reason, boolean writing, Result result) {
        if (usedRequestIds.contains(requestId)) {
            result.reject(new VaultException("CANCELLED", "This request ID is no longer usable."));
            return;
        }
        if (!available(result)) {
            return;
        }

        usedRequestIds.add(requestId);
        queued.addLast(new Request(requestId, result, writing ? Operation.SET : Operation.GET, id, value, reason));
        advance();
    }

    private void start(Request request) {
        request.working = true;
        worker.execute(() -> {
            Prepared prepared = null;
            VaultException error = null;
            try {
                switch (request.operation) {
                    case SET:
                        prepared = store.prepareSet(request.id, request.value);
                        break;
                    case GET:
                        prepared = store.prepareGet(request.id);
                        break;
                    case REMOVE:
                        store.remove(request.id);
                        break;
                    case CLEAR:
                        store.clear();
                        break;
                }
            } catch (VaultException exception) {
                error = exception;
            } catch (RuntimeException exception) {
                error = unexpected();
            }
            Prepared completedPreparation = prepared;
            VaultException preparationError = error;
            control.execute(() -> prepared(request, completedPreparation, request.reason, preparationError));
        });
    }

    private void prepared(Request request, Prepared prepared, String reason, VaultException error) {
        request.working = false;
        request.prepared = prepared;
        if (request.cancellation() != null || error != null) {
            finish(request, null, error);
            return;
        }
        if (prepared == null) {
            finish(request, null, null);
            return;
        }

        request.prompting = true;
        try {
            request.authentication = authenticator.authenticate(prepared.cipher(), reason, new AuthenticationCallback() {
                @Override
                public void authenticated(Cipher cipher) {
                    control.execute(() -> authenticatedResult(request, cipher, null));
                }

                @Override
                public void failed(VaultException failure) {
                    control.execute(() -> authenticatedResult(request, null, failure));
                }
            });
        } catch (VaultException exception) {
            authenticatedResult(request, null, exception);
        } catch (RuntimeException exception) {
            authenticatedResult(request, null, new VaultException("AUTHENTICATION_FAILED", "Unable to start biometric authentication."));
        }
    }

    private void authenticatedResult(Request request, Cipher cipher, VaultException error) {
        if (active != request || !request.prompting) {
            return;
        }
        request.prompting = false;
        request.authentication = null;
        if (request.cancellation() != null || error != null) {
            finish(request, null, error);
            return;
        }
        if (cipher == null || cipher != request.prepared.cipher()) {
            finish(request, null, new VaultException("AUTHENTICATION_FAILED", "Authentication did not authorize this operation."));
            return;
        }

        request.working = true;
        worker.execute(() -> {
            String value = null;
            VaultException failure = null;
            try {
                value = request.prepared.complete(request);
            } catch (VaultException exception) {
                failure = exception;
            } catch (RuntimeException exception) {
                failure = unexpected();
            } finally {
                closePrepared(request.prepared);
            }
            String completedValue = value;
            VaultException completionError = failure;
            control.execute(() -> {
                request.prepared = null;
                request.working = false;
                settle(request, completedValue, completionError);
            });
        });
    }

    void remove(String id, Result result) {
        enqueueMaintenance(Operation.REMOVE, id, result);
    }

    void clear(Result result) {
        enqueueMaintenance(Operation.CLEAR, null, result);
    }

    private void enqueueMaintenance(Operation operation, String id, Result result) {
        if (!available(result)) {
            return;
        }
        queued.addLast(new Request(null, result, operation, id, null, null));
        advance();
    }

    void cancel(String requestId) {
        usedRequestIds.add(requestId);
        if (active != null && requestId.equals(active.requestId)) {
            cancelActive(new VaultException("CANCELLED", "The operation was cancelled."));
            return;
        }
        Request cancelled = null;
        for (Request request : queued) {
            if (requestId.equals(request.requestId)) {
                cancelled = request;
                break;
            }
        }
        if (cancelled != null) {
            queued.remove(cancelled);
            deliveryDepth++;
            try {
                deliver(cancelled, null, new VaultException("CANCELLED", "The operation was cancelled."));
            } finally {
                deliveryDepth--;
                advance();
            }
        }
    }

    private void cancelActive(VaultException error) {
        Request request = active;
        if (request.finished || !request.cancel(error)) {
            return;
        }
        if (request.prompting) {
            // Wait for the prompt's terminal callback before allowing another prompt.
            if (request.authentication != null) {
                request.authentication.cancel();
            }
        } else if (!request.working) {
            finish(request, null, error);
        }
    }

    private boolean available(Result result) {
        if (destroyed || !foreground) {
            result.reject(new VaultException("APP_INACTIVE", "The app must be in the foreground."));
            return false;
        }
        return true;
    }

    private void finish(Request request, String value, VaultException error) {
        if (request.prepared == null) {
            settle(request, value, error);
            return;
        }
        request.working = true;
        worker.execute(() -> {
            closePrepared(request.prepared);
            control.execute(() -> {
                request.prepared = null;
                request.working = false;
                settle(request, value, error);
            });
        });
    }

    private void settle(Request request, String value, VaultException error) {
        if (active != request || request.finished) {
            return;
        }
        deliveryDepth++;
        try {
            deliver(request, value, error);
        } finally {
            active = null;
            deliveryDepth--;
            advance();
        }
    }

    private void deliver(Request request, String value, VaultException error) {
        request.finished = true;
        VaultException cancelled = request.cancellation();
        if (cancelled != null) {
            request.result.reject(cancelled);
        } else if (error != null) {
            request.result.reject(error);
        } else {
            request.result.resolve(value);
        }
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

    private static VaultException unexpected() {
        return new VaultException("IO_ERROR", "The vault operation could not be completed.");
    }

    private static void closePrepared(Prepared prepared) {
        try {
            prepared.close();
        } catch (RuntimeException ignored) {
            // Cleanup must not strand the request or turn a committed write into an apparent failure.
        }
    }

    private enum Operation { SET, GET, REMOVE, CLEAR }

    private static final class Request implements CommitGate {
        final String requestId;
        final Result result;
        final Operation operation;
        final String id;
        final String value;
        final String reason;
        Prepared prepared;
        Authentication authentication;
        boolean working;
        boolean prompting;
        boolean finished;
        private boolean committed;
        private VaultException cancelled;

        Request(String requestId, Result result, Operation operation, String id, String value, String reason) {
            this.requestId = requestId;
            this.result = result;
            this.operation = operation;
            this.id = id;
            this.value = value;
            this.reason = reason;
        }

        synchronized boolean cancel(VaultException error) {
            if (committed || cancelled != null) {
                return false;
            }
            cancelled = error;
            return true;
        }

        synchronized VaultException cancellation() {
            return cancelled;
        }

        @Override
        public synchronized void commit(CommitAction action) throws VaultException {
            if (cancelled != null) {
                throw cancelled;
            }
            action.run();
            committed = true;
        }
    }
}
