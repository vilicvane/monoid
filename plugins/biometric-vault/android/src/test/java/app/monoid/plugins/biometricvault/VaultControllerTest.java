package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import org.junit.Test;

public class VaultControllerTest {
    @Test
    public void oneAuthenticationAllowsMultipleOperationsAndDoesNotReserveTheQueue() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult missing = f.get(access, "missing", "get-missing");
        RecordingResult write = f.set(access, "entry", "new", "set");
        RecordingResult read = f.get(access, "entry", "get");
        f.drain();
        success(missing, null);
        success(write, null);
        success(read, "new");
        assertEquals(1, f.auth.prompts.size());
        assertEquals(List.of("get:missing", "set:entry", "get:entry"), f.store.calls);
        String anotherAccess = f.open("another-auth");
        assertNotEquals(access, anotherAccess);
        success(f.close(access), null);
        RecordingResult anotherRead = f.get(anotherAccess, "entry", "another-get");
        f.drain();
        success(anotherRead, "new");
    }

    @Test
    public void authenticationItselfQueuesBehindNativeCleanup() {
        Fixture f = new Fixture();
        String access = f.open("first-auth");
        RecordingResult write = f.set(access, "entry", "new", "write");
        RecordingResult authenticating = f.authenticate("second-auth");
        assertEquals(1, f.auth.prompts.size());
        f.runWorker();
        success(write, null);
        assertEquals(1, f.store.closed);
        assertEquals(2, f.auth.prompts.size());
        assertEquals(0, authenticating.settlements);
        f.auth.latest().succeed();
        f.control.runAll();
        assertNotNull(authenticating.value);
    }

    @Test
    public void preCancelledAndReusedIdsNeverRunNativeWork() {
        Fixture f = new Fixture();
        f.controller.cancel("pre-auth");
        failure(f.authenticate("pre-auth"), "CANCELLED");
        assertTrue(f.auth.prompts.isEmpty());
        String access = f.open("auth");
        failure(f.authenticate("auth"), "CANCELLED");
        f.controller.cancel("pre-get");
        failure(f.get(access, "entry", "pre-get"), "CANCELLED");
        assertTrue(f.store.calls.isEmpty());
    }

    @Test
    public void cancellingAuthenticationWaitsForTerminalCallbackAndRejectsQueuedSuccess() {
        Fixture f = new Fixture();
        RecordingResult first = f.authenticate("first");
        FakePrompt oldPrompt = f.auth.latest();
        RecordingResult second = f.authenticate("second");
        f.controller.cancel("first");
        assertEquals(1, oldPrompt.cancelCalls);
        assertEquals(1, f.auth.prompts.size());
        oldPrompt.succeed();
        f.control.runAll();
        failure(first, "CANCELLED");
        assertEquals(2, f.auth.prompts.size());
        oldPrompt.succeed();
        oldPrompt.fail("AUTHENTICATION_FAILED");
        f.control.runAll();
        assertEquals(0, second.settlements);
        f.auth.latest().succeed();
        f.control.runAll();
        assertEquals(1, second.settlements);
        assertNotNull(second.value);
    }

    @Test
    public void cancellingQueuedOperationsDoesNotTouchCurrentPrompt() {
        Fixture f = new Fixture();
        String access = f.open("access");
        RecordingResult prompt = f.authenticate("active-auth");
        RecordingResult queued = f.set(access, "entry", "new", "queued");
        f.controller.cancel("queued");
        failure(queued, "CANCELLED");
        assertEquals(0, f.auth.latest().cancelCalls);
        f.auth.latest().succeed();
        f.control.runAll();
        assertNotNull(prompt.value);
        assertTrue(f.store.calls.isEmpty());
    }

    @Test
    public void closeIsImmediateButWaitsForInFlightCleanupAndIsIdempotent() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult write = f.set(access, "entry", "new", "active");
        RecordingResult queued = f.get(access, "entry", "queued");
        RecordingResult closed = f.close(access);
        RecordingResult closedAgain = f.close(access);
        failure(queued, "ACCESS_CLOSED");
        failure(f.get(access, "entry", "late"), "ACCESS_CLOSED");
        assertEquals(0, closed.settlements);
        assertEquals(0, closedAgain.settlements);
        f.drain();
        failure(write, "ACCESS_CLOSED");
        success(closed, null);
        success(closedAgain, null);
        success(f.close(access), null);
        success(f.close("unknown"), null);
        assertTrue(f.store.calls.isEmpty());
    }

    @Test
    public void closeDuringPreparationCleansUpBeforeReleasingCloseWaiters() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult[] close = new RecordingResult[1];
        f.store.afterPrepare = prepared -> close[0] = f.close(access);
        RecordingResult write = f.set(access, "entry", "new", "set");
        f.worker.runAll();
        assertEquals(1, f.store.closed);
        assertEquals(0, f.store.completed);
        assertEquals(0, close[0].settlements);
        f.control.runAll();
        failure(write, "ACCESS_CLOSED");
        success(close[0], null);
    }

    @Test
    public void cancellingImmediatelyBeforeCommitKeepsThePreviousValue() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        f.store.values.put("entry", "old");
        f.store.beforeCommit = () -> f.controller.cancel("set");
        RecordingResult write = f.set(access, "entry", "new", "set");
        f.drain();
        failure(write, "CANCELLED");
        assertEquals("old", f.store.values.get("entry"));
        assertEquals(1, f.store.closed);
        f.store.beforeCommit = () -> {};
        RecordingResult next = f.get(access, "entry", "next");
        f.drain();
        success(next, "old");
    }

    @Test
    public void committedWriteWinsOverCloseCancellationExpiryAndBackground() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult write = f.set(access, "entry", "new", "set");
        f.worker.runAll();
        assertEquals("new", f.store.values.get("entry"));
        RecordingResult closed = f.close(access);
        f.controller.cancel("set");
        f.now = 60_000;
        f.controller.setForeground(false);
        assertEquals(0, closed.settlements);
        f.control.runAll();
        success(write, null);
        success(closed, null);
    }

    @Test
    public void plaintextReadIsNotDeliveredAfterCancelCloseExpiryOrPause() {
        for (String interruption : List.of("cancel", "close", "expire", "pause")) {
            Fixture f = new Fixture();
            String access = f.open("auth");
            f.store.values.put("entry", "secret");
            RecordingResult read = f.get(access, "entry", "get");
            f.worker.runAll();
            String code;
            switch (interruption) {
                case "cancel": f.controller.cancel("get"); code = "CANCELLED"; break;
                case "close": f.close(access); code = "ACCESS_CLOSED"; break;
                case "expire": f.now = 60_000; code = "AUTHORIZATION_EXPIRED"; break;
                default: f.controller.setForeground(false); code = "APP_INACTIVE";
            }
            f.control.runAll();
            failure(read, code);
            assertEquals(1, f.store.closed);
        }
    }

    @Test
    public void expiryIsCheckedAtAdmissionAtQueuedExecutionAndBeforeCommit() {
        Fixture admission = new Fixture();
        String first = admission.open("auth");
        admission.now = 59_999;
        RecordingResult valid = admission.get(first, "missing", "valid");
        admission.drain();
        success(valid, null);
        admission.now = 60_000;
        failure(admission.get(first, "missing", "expired"), "AUTHORIZATION_EXPIRED");

        Fixture queued = new Fixture();
        String second = queued.open("auth");
        RecordingResult pendingAuth = queued.authenticate("hold-queue");
        RecordingResult pendingWrite = queued.set(second, "entry", "new", "queued");
        queued.now = 60_000;
        queued.auth.latest().succeed();
        queued.drain();
        assertNotNull(pendingAuth.value);
        failure(pendingWrite, "AUTHORIZATION_EXPIRED");
        assertTrue(queued.store.calls.isEmpty());

        Fixture commit = new Fixture();
        String third = commit.open("auth");
        commit.store.values.put("entry", "old");
        commit.store.beforeCommit = () -> commit.now = 60_000;
        RecordingResult write = commit.set(third, "entry", "new", "set");
        commit.drain();
        failure(write, "AUTHORIZATION_EXPIRED");
        assertEquals("old", commit.store.values.get("entry"));
    }

    @Test
    public void scopeClockStartsAtTheAuthenticationCallbackNotItsDelayedDelivery() {
        Fixture f = new Fixture();
        RecordingResult authenticating = f.authenticate("auth");
        f.auth.latest().succeed();
        f.now = 60_000;
        f.control.runAll();
        failure(authenticating, "AUTHORIZATION_EXPIRED");
    }

    @Test
    public void platformAuthorizationExpiryInvalidatesTheScopeAndItsQueue() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        f.store.prepareFailure = error("AUTHORIZATION_EXPIRED");
        RecordingResult first = f.set(access, "entry", "new", "first");
        RecordingResult queued = f.get(access, "entry", "queued");
        f.drain();
        failure(first, "AUTHORIZATION_EXPIRED");
        failure(queued, "AUTHORIZATION_EXPIRED");
        assertEquals(1, f.store.calls.size());
        assertEquals(1, f.auth.prompts.size());
    }

    @Test
    public void backgroundRevokesAllScopesAndNeverRevivesTheirOperations() {
        Fixture f = new Fixture();
        String first = f.open("first");
        String second = f.open("second");
        RecordingResult active = f.set(first, "entry", "new", "set");
        RecordingResult queued = f.get(second, "entry", "get");
        RecordingResult clear = f.clear();
        f.controller.setForeground(false);
        failure(queued, "APP_INACTIVE");
        failure(clear, "APP_INACTIVE");
        f.controller.setForeground(true);
        f.drain();
        failure(active, "APP_INACTIVE");
        failure(f.get(first, "entry", "first-late"), "ACCESS_CLOSED");
        failure(f.get(second, "entry", "second-late"), "ACCESS_CLOSED");
        assertTrue(f.store.calls.isEmpty());
        assertEquals(2, f.auth.prompts.size());
    }

    @Test
    public void backgroundCancelsPendingAuthenticationEvenIfSuccessWasAlreadyQueued() {
        Fixture f = new Fixture();
        RecordingResult authenticating = f.authenticate("auth");
        f.auth.latest().succeed();
        f.controller.setForeground(false);
        f.controller.setForeground(true);
        f.control.runAll();
        failure(authenticating, "APP_INACTIVE");
        assertEquals(1, f.auth.prompts.size());
    }

    @Test
    public void scopedRemoveChecksTheSameCommitGateAndCommittedDeletionWins() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        f.store.values.put("entry", "old");
        f.store.beforeCommit = () -> f.controller.cancel("remove");
        RecordingResult cancelled = f.remove(access, "entry", "remove");
        f.drain();
        failure(cancelled, "CANCELLED");
        assertEquals("old", f.store.values.get("entry"));
        f.store.beforeCommit = () -> {};
        RecordingResult removed = f.remove(access, "entry", "remove-2");
        f.worker.runAll();
        f.close(access);
        f.control.runAll();
        success(removed, null);
        assertFalse(f.store.values.containsKey("entry"));
    }

    @Test
    public void globalMaintenanceNeedsNoScopeAndSharesFifoWithAuthenticatedWork() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult write = f.set(access, "entry", "new", "set");
        RecordingResult remove = f.remove(null, "entry", null);
        RecordingResult missing = f.get(access, "entry", "get");
        RecordingResult clear = f.clear();
        f.drain();
        success(write, null);
        success(remove, null);
        success(missing, null);
        success(clear, null);
        assertEquals(List.of("set:entry", "remove:entry", "get:entry", "clear"), f.store.calls);
        assertEquals(1, f.auth.prompts.size());
    }

    @Test
    public void failuresAndCleanupExceptionsCannotStrandTheQueue() {
        for (String phase : List.of("prepare", "complete", "commit", "runtime", "cleanup")) {
            Fixture f = new Fixture();
            String access = f.open("auth");
            f.store.values.put("entry", "old");
            if (phase.equals("prepare")) f.store.prepareFailure = error("IO_ERROR");
            if (phase.equals("complete")) f.store.completeFailure = error("DATA_CORRUPTED");
            if (phase.equals("commit")) f.store.commitFailure = error("IO_ERROR");
            if (phase.equals("runtime")) f.store.runtimeFailure = new IllegalStateException("secret");
            if (phase.equals("cleanup")) f.store.closeFailure = new IllegalStateException("secret");
            RecordingResult write = f.set(access, "entry", "new", "set");
            RecordingResult clear = f.clear();
            f.drain();
            if (phase.equals("cleanup")) success(write, null);
            else failure(write, phase.equals("complete") ? "DATA_CORRUPTED" : "IO_ERROR");
            success(clear, null);
            assertTrue(f.store.values.isEmpty());
        }
    }

    @Test
    public void authenticationStartAndTerminalFailuresDoNotBlockTheQueue() {
        Fixture f = new Fixture();
        f.auth.startFailure = error("UNSUPPORTED");
        failure(f.authenticate("unsupported"), "UNSUPPORTED");
        f.auth.startFailure = null;
        RecordingResult failed = f.authenticate("failed");
        RecordingResult queued = f.authenticate("queued");
        f.auth.latest().fail("BIOMETRIC_LOCKED_OUT");
        f.control.runAll();
        failure(failed, "BIOMETRIC_LOCKED_OUT");
        f.auth.latest().succeed();
        f.control.runAll();
        assertNotNull(queued.value);
    }

    @Test
    public void destroyWaitsForNativeCleanupAndCloseWaitersBeforeReleasingWorker() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult write = f.set(access, "entry", "new", "set");
        RecordingResult close = f.close(access);
        int[] destroyed = { 0 };
        f.controller.destroy(() -> {
            assertEquals(1, close.settlements);
            assertEquals(1, write.settlements);
            destroyed[0]++;
        });
        assertEquals(0, destroyed[0]);
        f.drain();
        failure(write, "ACCESS_CLOSED");
        success(close, null);
        assertEquals(1, destroyed[0]);
        failure(f.authenticate("late"), "APP_INACTIVE");
    }

    @Test
    public void destroyWaitsForAuthenticationCancellation() {
        Fixture f = new Fixture();
        RecordingResult authenticating = f.authenticate("auth");
        int[] destroyed = { 0 };
        f.controller.destroy(() -> destroyed[0]++);
        assertEquals(1, f.auth.latest().cancelCalls);
        assertEquals(0, destroyed[0]);
        f.auth.latest().fail("CANCELLED");
        f.control.runAll();
        failure(authenticating, "APP_INACTIVE");
        assertEquals(1, destroyed[0]);
    }

    @Test
    public void resultReentryCannotOvertakeQueuedWorkOrStartBeforeCleanup() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult first = f.set(access, "entry", "new", "set");
        RecordingResult second = f.get(access, "entry", "get");
        RecordingResult[] third = new RecordingResult[1];
        first.afterSettlement = () -> {
            assertEquals(1, f.store.closed);
            third[0] = f.clear();
            assertTrue(f.worker.tasks.isEmpty());
            f.controller.cancel("set");
        };
        f.drain();
        success(first, null);
        success(second, "new");
        success(third[0], null);
        assertEquals(List.of("set:entry", "get:entry", "clear"), f.store.calls);
    }

    @Test
    public void reentrantResumeDuringBackgroundRejectionCannotReviveOldQueue() {
        Fixture f = new Fixture();
        String access = f.open("auth");
        RecordingResult first = f.set(access, "entry", "new", "set");
        RecordingResult queued = f.get(access, "entry", "get");
        RecordingResult clearing = f.clear();
        RecordingResult[] resumed = new RecordingResult[1];
        queued.afterSettlement = () -> {
            f.controller.setForeground(true);
            resumed[0] = f.authenticate("new-auth");
        };
        f.controller.setForeground(false);
        failure(queued, "APP_INACTIVE");
        failure(clearing, "APP_INACTIVE");
        f.drain();
        failure(first, "APP_INACTIVE");
        assertEquals(0, resumed[0].settlements);
        f.auth.latest().succeed();
        f.control.runAll();
        assertNotNull(resumed[0].value);
        assertTrue(f.store.calls.isEmpty());
    }

    private static void success(RecordingResult result, String value) {
        assertEquals(1, result.settlements);
        assertNull(result.error);
        assertEquals(value, result.value);
    }
    private static void failure(RecordingResult result, String code) {
        assertEquals(1, result.settlements);
        assertNotNull(result.error);
        assertEquals(code, result.error.code());
        assertNull(result.value);
    }
    private static VaultException error(String code) { return new VaultException(code, "Controlled failure"); }

    private static final class RecordingResult implements VaultController.Result {
        int settlements;
        String value;
        VaultException error;
        Runnable afterSettlement = () -> {};
        @Override public void resolve(String value) {
            settlements++;
            this.value = value;
            afterSettlement.run();
        }
        @Override public void reject(VaultException error) {
            settlements++;
            this.error = error;
            afterSettlement.run();
        }
    }

    private static final class QueueExecutor implements Executor {
        final Queue<Runnable> tasks = new ArrayDeque<>();
        @Override public void execute(Runnable action) { tasks.add(action); }
        void runAll() { while (!tasks.isEmpty()) tasks.remove().run(); }
    }

    private static final class FakeStore implements VaultController.Store {
        final Map<String, String> values = new HashMap<>();
        final List<String> calls = new ArrayList<>();
        int completed;
        int closed;
        VaultException prepareFailure;
        VaultException completeFailure;
        VaultException commitFailure;
        RuntimeException runtimeFailure;
        RuntimeException closeFailure;
        Consumer<VaultController.Prepared> afterPrepare = prepared -> {};
        Runnable beforeCommit = () -> {};
        @Override public VaultController.Prepared prepareSet(String id, String value) throws VaultException {
            calls.add("set:" + id);
            return prepare(id, value, true);
        }
        @Override public VaultController.Prepared prepareGet(String id) throws VaultException {
            calls.add("get:" + id);
            return prepare(id, values.get(id), false);
        }
        private VaultController.Prepared prepare(String id, String value, boolean writing) throws VaultException {
            if (prepareFailure != null) throw prepareFailure;
            if (runtimeFailure != null) throw runtimeFailure;
            if (!writing && value == null) return null;
            VaultController.Prepared prepared = new VaultController.Prepared() {
                @Override public String complete(VaultController.CommitGate gate) throws VaultException {
                    completed++;
                    if (completeFailure != null) throw completeFailure;
                    if (!writing) return value;
                    beforeCommit.run();
                    gate.commit(() -> {
                        if (commitFailure != null) throw commitFailure;
                        values.put(id, value);
                    });
                    return null;
                }
                @Override public void close() {
                    closed++;
                    if (closeFailure != null) throw closeFailure;
                }
            };
            afterPrepare.accept(prepared);
            return prepared;
        }
        @Override public void remove(String id, VaultController.CommitGate gate) throws VaultException {
            calls.add("remove:" + id);
            beforeCommit.run();
            gate.commit(() -> values.remove(id));
        }
        @Override public void clear() {
            calls.add("clear");
            values.clear();
        }
    }

    private static final class FakeAuthenticator implements VaultController.Authenticator {
        final List<FakePrompt> prompts = new ArrayList<>();
        VaultException startFailure;
        @Override public VaultController.Authentication authenticate(String reason, VaultController.AuthenticationCallback callback)
            throws VaultException {
            if (startFailure != null) throw startFailure;
            FakePrompt prompt = new FakePrompt(callback);
            prompts.add(prompt);
            return prompt;
        }
        FakePrompt latest() { return prompts.get(prompts.size() - 1); }
    }
    private static final class FakePrompt implements VaultController.Authentication {
        final VaultController.AuthenticationCallback callback;
        int cancelCalls;
        FakePrompt(VaultController.AuthenticationCallback callback) { this.callback = callback; }
        void succeed() { callback.authenticated(); }
        void fail(String code) { callback.failed(error(code)); }
        @Override public void cancel() { cancelCalls++; }
    }

    private static final class Fixture {
        final FakeStore store = new FakeStore();
        final FakeAuthenticator auth = new FakeAuthenticator();
        final QueueExecutor control = new QueueExecutor();
        final QueueExecutor worker = new QueueExecutor();
        long now;
        final VaultController controller = new VaultController(store, auth, control, worker, () -> now);
        Fixture() { controller.setForeground(true); }
        RecordingResult authenticate(String requestId) {
            RecordingResult result = new RecordingResult();
            controller.authenticate(requestId, "Access vault", result);
            return result;
        }
        String open(String requestId) {
            RecordingResult result = authenticate(requestId);
            auth.latest().succeed();
            control.runAll();
            assertEquals(1, result.settlements);
            assertNull(result.error);
            assertNotNull(result.value);
            return result.value;
        }
        RecordingResult get(String access, String id, String requestId) {
            RecordingResult result = new RecordingResult();
            controller.get(access, id, requestId, result);
            return result;
        }
        RecordingResult set(String access, String id, String value, String requestId) {
            RecordingResult result = new RecordingResult();
            controller.set(access, id, value, requestId, result);
            return result;
        }
        RecordingResult remove(String access, String id, String requestId) {
            RecordingResult result = new RecordingResult();
            controller.remove(access, id, requestId, result);
            return result;
        }
        RecordingResult close(String access) {
            RecordingResult result = new RecordingResult();
            controller.closeAccess(access, result);
            return result;
        }
        RecordingResult clear() {
            RecordingResult result = new RecordingResult();
            controller.clear(result);
            return result;
        }
        void runWorker() { worker.runAll(); control.runAll(); }
        void drain() { while (!worker.tasks.isEmpty() || !control.tasks.isEmpty()) runWorker(); }
    }
}
