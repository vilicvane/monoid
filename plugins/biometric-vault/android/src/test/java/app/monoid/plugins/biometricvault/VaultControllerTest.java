package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.Executor;
import javax.crypto.Cipher;
import org.junit.Test;

public class VaultControllerTest {
    @Test
    public void missingEntriesReturnNullWithoutAuthenticationOrKeyPreparation() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.get("missing", "get");
        fixture.runWorker();

        assertSuccess(result, null);
        assertEquals(1, fixture.store.getCalls);
        assertEquals(0, fixture.store.setCalls);
        assertTrue(fixture.store.preparations.isEmpty());
        assertTrue(fixture.auth.prompts.isEmpty());
    }

    @Test
    public void setDoesNotReplaceTheOldValueUntilItsCipherIsAuthenticatedAndCommitted() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "old");
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        FakePrepared prepared = fixture.store.latest();
        FakePrompt prompt = fixture.auth.latest();

        assertSame(prepared.cipher, prompt.cipher);
        assertEquals("Save or read this entry", prompt.reason);
        assertEquals("old", fixture.store.values.get("entry"));
        assertEquals(0, result.settlements);
        prompt.succeed();
        fixture.control.runAll();
        assertEquals("old", fixture.store.values.get("entry"));
        fixture.runWorker();

        assertSuccess(result, null);
        assertEquals("new", fixture.store.values.get("entry"));
        assertEquals(1, prepared.completeCalls);
        assertEquals(1, prepared.closeCalls);
    }

    @Test
    public void eachReadAuthenticatesAndReturnsOnlyItsOwnPreparedValue() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "stored");
        RecordingResult first = fixture.get("entry", "first");
        fixture.runWorker();
        fixture.authenticateAndComplete();
        assertSuccess(first, "stored");
        RecordingResult second = fixture.get("entry", "second");
        fixture.runWorker();
        assertEquals(2, fixture.auth.prompts.size());
        assertEquals(0, second.settlements);
        assertNotSame(fixture.auth.prompts.get(0).cipher, fixture.auth.prompts.get(1).cipher);
        fixture.authenticateAndComplete();
        assertSuccess(second, "stored");
    }

    @Test
    public void cancellingBeforePreparationReturnsCleansUpWithoutDisplayingAPrompt() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "old");
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.controller.cancel("set");
        RecordingResult queued = fixture.get("missing", "queued");
        fixture.runWorker();
        assertEquals(0, result.settlements);
        assertTrue(fixture.auth.prompts.isEmpty());
        fixture.runWorker();

        assertFailure(result, "CANCELLED");
        assertEquals("old", fixture.store.values.get("entry"));
        assertEquals(0, fixture.store.latest().completeCalls);
        assertEquals(1, fixture.store.latest().closeCalls);
        assertEquals(0, queued.settlements);
        assertEquals(0, fixture.store.getCalls);
        fixture.runWorker();
        assertSuccess(queued, null);
    }

    @Test
    public void cancellationAfterPreparationButBeforeItsControlCallbackStillCleansUp() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.worker.runAll();
        fixture.controller.cancel("set");
        fixture.control.runAll();
        fixture.runWorker();

        assertFailure(result, "CANCELLED");
        assertFalse(fixture.store.values.containsKey("entry"));
        assertTrue(fixture.auth.prompts.isEmpty());
        assertEquals(1, fixture.store.latest().closeCalls);
    }

    @Test
    public void cancellingAPromptWaitsForItsTerminalCallbackAndCleanup() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        FakePrompt prompt = fixture.auth.latest();
        fixture.controller.cancel("set");
        fixture.controller.cancel("set");

        assertEquals(1, prompt.cancelCalls);
        assertEquals(0, result.settlements);
        RecordingResult queued = fixture.get("missing", "queued");
        prompt.fail("AUTHENTICATION_FAILED");
        fixture.control.runAll();
        assertEquals(0, result.settlements);
        fixture.runWorker();

        assertFailure(result, "CANCELLED");
        assertEquals(0, fixture.store.latest().completeCalls);
        assertEquals(1, fixture.store.latest().closeCalls);
        assertEquals(0, queued.settlements);
        assertEquals(0, fixture.store.getCalls);
        fixture.runWorker();
        assertSuccess(queued, null);
    }

    @Test
    public void cancellationWinsOverAnAuthenticationSuccessAlreadyQueuedForControl() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        fixture.auth.latest().succeed();
        fixture.controller.cancel("set");
        fixture.control.runAll();
        fixture.runWorker();

        assertFailure(result, "CANCELLED");
        assertEquals(0, fixture.store.latest().completeCalls);
        assertFalse(fixture.store.values.containsKey("entry"));
    }

    @Test
    public void cancellationImmediatelyBeforeCommitKeepsThePreviousValue() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "old");
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        fixture.store.latest().beforeCommit = () -> fixture.controller.cancel("set");
        fixture.authenticateAndComplete();

        assertFailure(result, "CANCELLED");
        assertEquals("old", fixture.store.values.get("entry"));
        assertEquals(1, fixture.store.latest().completeCalls);
        assertEquals(1, fixture.store.latest().closeCalls);
    }

    @Test
    public void cancellationAndBackgroundAfterCommitCannotRollBackOrMisreportTheWrite() {
        for (boolean background : new boolean[] { false, true }) {
            Fixture fixture = new Fixture();
            fixture.store.values.put("entry", "old");
            RecordingResult result = fixture.set("entry", "new", "set");
            fixture.runWorker();
            fixture.auth.latest().succeed();
            fixture.control.runAll();
            fixture.worker.runAll(); // The write committed; its result is still queued.
            if (background) {
                fixture.controller.setForeground(false);
            } else {
                fixture.controller.cancel("set");
            }
            fixture.control.runAll();

            assertSuccess(result, null);
            assertEquals("new", fixture.store.values.get("entry"));
            assertEquals(1, fixture.store.latest().closeCalls);
        }
    }

    @Test
    public void cancellingACompletedReadBeforeDeliveryDoesNotReleaseThePlaintext() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "stored");
        RecordingResult result = fixture.get("entry", "get");
        fixture.runWorker();
        fixture.auth.latest().succeed();
        fixture.control.runAll();
        fixture.worker.runAll();
        fixture.controller.cancel("get");
        fixture.control.runAll();

        assertFailure(result, "CANCELLED");
        assertNull(result.value);
        assertEquals(1, fixture.store.latest().closeCalls);
    }

    @Test
    public void preCancelledQueuedAndCompletedRequestIdsCannotBeReused() {
        Fixture fixture = new Fixture();
        fixture.controller.cancel("cancelled");
        assertFailure(fixture.set("entry", "new", "cancelled"), "CANCELLED");
        RecordingResult first = fixture.get("missing", "first");
        RecordingResult queued = fixture.get("missing", "queued");
        assertFailure(fixture.get("missing", "queued"), "CANCELLED");
        fixture.runWorker();
        assertSuccess(first, null);
        assertFailure(fixture.get("missing", "first"), "CANCELLED");

        fixture.runWorker();
        assertSuccess(queued, null);
        assertFailure(fixture.get("missing", "queued"), "CANCELLED");
        assertEquals(0, fixture.store.setCalls);
        fixture.controller.setForeground(false);
        assertFailure(fixture.get("missing", "cancelled"), "CANCELLED");
        assertFailure(fixture.get("missing", "queued"), "CANCELLED");
        assertFailure(fixture.get("missing", "new"), "APP_INACTIVE");
    }

    @Test
    public void cancellingAnotherIdDoesNotCancelTheCurrentPrompt() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        fixture.controller.cancel("another");
        assertEquals(0, fixture.auth.latest().cancelCalls);
        fixture.authenticateAndComplete();

        assertSuccess(result, null);
        assertFailure(fixture.get("entry", "another"), "CANCELLED");
    }

    @Test
    public void staleOrDuplicateAuthenticationCallbacksCannotAuthorizeTheNextRequest() {
        Fixture fixture = new Fixture();
        RecordingResult first = fixture.set("entry", "first", "first");
        fixture.runWorker();
        FakePrompt oldPrompt = fixture.auth.latest();
        fixture.authenticateAndComplete();
        assertSuccess(first, null);
        RecordingResult second = fixture.set("entry", "second", "second");
        fixture.runWorker();
        FakePrepared secondPreparation = fixture.store.latest();
        oldPrompt.succeed();
        oldPrompt.fail("CANCELLED");
        fixture.control.runAll();
        fixture.runWorker();

        assertEquals(0, second.settlements);
        assertEquals(0, secondPreparation.completeCalls);
        assertEquals(1, first.settlements);
        fixture.authenticateAndComplete();
        assertSuccess(second, null);
        assertEquals("second", fixture.store.values.get("entry"));
    }

    @Test
    public void authenticationMustReturnTheExactPreparedCipher() {
        for (Cipher unexpected : new Cipher[] { null, newCipher() }) {
            Fixture fixture = new Fixture();
            RecordingResult result = fixture.set("entry", "new", "set");
            fixture.runWorker();
            fixture.auth.latest().callback.authenticated(unexpected);
            fixture.control.runAll();
            fixture.runWorker();

            assertFailure(result, "AUTHENTICATION_FAILED");
            assertFalse(fixture.store.values.containsKey("entry"));
            assertEquals(0, fixture.store.latest().completeCalls);
            assertEquals(1, fixture.store.latest().closeCalls);
        }
    }

    @Test
    public void preparationErrorsReleaseTheOperationWithoutAuthentication() {
        for (boolean checked : new boolean[] { true, false }) {
            Fixture fixture = new Fixture();
            fixture.store.prepareFailure = checked ? failure("ENTRY_INVALIDATED") : null;
            fixture.store.prepareRuntimeFailure = checked ? null : new IllegalStateException("Unavailable store");
            RecordingResult result = fixture.get("entry", "get");
            fixture.runWorker();

            assertFailure(result, checked ? "ENTRY_INVALIDATED" : "IO_ERROR");
            assertTrue(fixture.auth.prompts.isEmpty());
            fixture.store.prepareFailure = null;
            fixture.store.prepareRuntimeFailure = null;
            RecordingResult next = fixture.get("missing", "next");
            fixture.runWorker();
            assertSuccess(next, null);
        }
    }

    @Test
    public void authenticationStartOrTerminalErrorsCleanUpThePreparedOperation() {
        for (int mode = 0; mode < 3; mode++) {
            Fixture fixture = new Fixture();
            if (mode == 0) {
                fixture.auth.startFailure = failure("BIOMETRIC_UNAVAILABLE");
            } else if (mode == 1) {
                fixture.auth.startRuntimeFailure = new IllegalStateException("Unable to show prompt");
            }
            RecordingResult result = fixture.set("entry", "new", "set");
            fixture.runWorker();
            if (mode == 2) {
                fixture.auth.latest().fail("BIOMETRIC_LOCKED_OUT");
                fixture.control.runAll();
            }
            fixture.runWorker();

            assertFailure(result, mode == 0 ? "BIOMETRIC_UNAVAILABLE"
                : mode == 1 ? "AUTHENTICATION_FAILED" : "BIOMETRIC_LOCKED_OUT");
            assertEquals(1, fixture.store.latest().closeCalls);
            assertEquals(0, fixture.store.latest().completeCalls);
        }
    }

    @Test
    public void completionAndCommitFailuresPreserveThePreviousEntry() {
        for (int mode = 0; mode < 3; mode++) {
            Fixture fixture = new Fixture();
            fixture.store.values.put("entry", "old");
            RecordingResult result = fixture.set("entry", "new", "set");
            fixture.runWorker();
            FakePrepared prepared = fixture.store.latest();
            if (mode == 0) {
                prepared.completeFailure = failure("DATA_CORRUPTED");
            } else if (mode == 1) {
                prepared.completeRuntimeFailure = new IllegalStateException("Cipher failed");
            } else {
                prepared.commitFailure = failure("IO_ERROR");
            }
            fixture.authenticateAndComplete();

            assertFailure(result, mode == 0 ? "DATA_CORRUPTED" : "IO_ERROR");
            assertEquals("old", fixture.store.values.get("entry"));
            assertEquals(1, prepared.closeCalls);
        }
    }

    @Test
    public void cleanupExceptionsDoNotHideACommittedWriteOrBlockTheQueue() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        fixture.store.latest().closeRuntimeFailure = new IllegalStateException("Cleanup failed");
        fixture.authenticateAndComplete();

        assertSuccess(result, null);
        assertEquals("new", fixture.store.values.get("entry"));
        assertEquals(1, fixture.store.latest().closeCalls);
        RecordingResult next = fixture.get("missing", "next");
        fixture.runWorker();
        assertSuccess(next, null);
    }

    @Test
    public void cleanupExceptionsDoNotStrandACancelledRequestOrDestroy() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.worker.runAll();
        fixture.store.latest().closeRuntimeFailure = new IllegalStateException("Cleanup failed");
        int[] destroyedCalls = { 0 };
        fixture.controller.destroy(() -> destroyedCalls[0]++);
        fixture.control.runAll();
        fixture.runWorker();

        assertFailure(result, "APP_INACTIVE");
        assertEquals(1, destroyedCalls[0]);
        assertEquals(1, fixture.store.latest().closeCalls);
        assertFalse(fixture.store.values.containsKey("entry"));
    }

    @Test
    public void removeAndInteractiveOperationsRunInOrderWithoutPromptingForRemoval() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "old");
        RecordingResult writing = fixture.set("entry", "new", "set");
        fixture.runWorker();
        RecordingResult removing = fixture.remove("entry");
        RecordingResult reading = fixture.get("entry", "get");
        RecordingResult removeMissing = fixture.remove("entry");
        assertEquals(0, fixture.store.removeCalls);
        fixture.authenticateAndComplete();
        assertSuccess(writing, null);

        fixture.runWorker();
        assertSuccess(removing, null);
        assertFalse(fixture.store.values.containsKey("entry"));
        fixture.runWorker();
        assertSuccess(reading, null);
        fixture.runWorker();
        assertSuccess(removeMissing, null);
        assertEquals(1, fixture.auth.prompts.size());
    }

    @Test
    public void removeFailuresAreReportedAndDoNotBlockTheQueue() {
        Fixture fixture = new Fixture();
        fixture.store.removeFailure = failure("IO_ERROR");
        RecordingResult failed = fixture.remove("entry");
        RecordingResult next = fixture.get("missing", "next");
        fixture.runWorker();
        assertFailure(failed, "IO_ERROR");
        fixture.store.removeFailure = null;
        fixture.runWorker();
        assertSuccess(next, null);
    }

    @Test
    public void backgroundCancelsThePromptAndResumeDoesNotReviveTheOldRequest() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        FakePrompt prompt = fixture.auth.latest();
        fixture.controller.setForeground(false);
        assertEquals(1, prompt.cancelCalls);
        assertFailure(fixture.get("entry", "inactive"), "APP_INACTIVE");
        fixture.controller.setForeground(true);
        RecordingResult next = fixture.get("missing", "next");
        assertEquals(0, next.settlements);
        prompt.succeed();
        fixture.control.runAll();
        fixture.runWorker();

        assertFailure(result, "APP_INACTIVE");
        assertFalse(fixture.store.values.containsKey("entry"));
        assertFailure(fixture.get("entry", "set"), "CANCELLED");
        fixture.runWorker();
        assertSuccess(next, null);
    }

    @Test
    public void destroyWaitsForPreparationAndCleanupBeforeReleasingTheWorker() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        int[] destroyedCalls = { 0 };
        fixture.controller.destroy(() -> destroyedCalls[0]++);
        assertEquals(0, destroyedCalls[0]);
        fixture.runWorker();
        assertEquals(0, destroyedCalls[0]);
        fixture.runWorker();

        assertFailure(result, "APP_INACTIVE");
        assertEquals(1, destroyedCalls[0]);
        assertEquals(1, fixture.store.latest().closeCalls);
        assertTrue(fixture.auth.prompts.isEmpty());
        fixture.controller.setForeground(true);
        assertFailure(fixture.get("missing", "next"), "APP_INACTIVE");
        assertFailure(fixture.remove("entry"), "APP_INACTIVE");
        assertFailure(fixture.clear(), "APP_INACTIVE");
    }

    @Test
    public void destroyWaitsForPromptCancellationAndDoesNotRepeatItsCompletionCallback() {
        Fixture fixture = new Fixture();
        RecordingResult result = fixture.set("entry", "new", "set");
        fixture.runWorker();
        FakePrompt prompt = fixture.auth.latest();
        int[] destroyedCalls = { 0 };
        fixture.controller.destroy(() -> destroyedCalls[0]++);
        assertEquals(1, prompt.cancelCalls);
        assertEquals(0, destroyedCalls[0]);
        prompt.fail("CANCELLED");
        fixture.control.runAll();
        fixture.runWorker();
        prompt.succeed();
        fixture.control.runAll();

        assertFailure(result, "APP_INACTIVE");
        assertEquals(1, destroyedCalls[0]);
        assertEquals(1, fixture.store.latest().closeCalls);
    }

    @Test
    public void destroyLetsAnAlreadyStartedRemovalFinish() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "old");
        RecordingResult result = fixture.remove("entry");
        int[] destroyedCalls = { 0 };
        fixture.controller.destroy(() -> destroyedCalls[0]++);
        assertEquals(0, destroyedCalls[0]);
        fixture.runWorker();

        assertSuccess(result, null);
        assertFalse(fixture.store.values.containsKey("entry"));
        assertEquals(1, destroyedCalls[0]);
        assertTrue(fixture.auth.prompts.isEmpty());
    }

    @Test
    public void queuedReadsObserveWritesAndClearAtTheirFifoPosition() {
        Fixture fixture = new Fixture();
        RecordingResult writing = fixture.set("entry", "new", "set");
        RecordingResult reading = fixture.get("entry", "get");
        RecordingResult clearing = fixture.clear();
        RecordingResult missing = fixture.get("entry", "after-clear");
        fixture.runWorker();
        assertEquals(0, fixture.store.getCalls);
        assertEquals(0, fixture.store.clearCalls);
        fixture.authenticateAndComplete();
        assertSuccess(writing, null);
        fixture.runWorker();
        assertEquals(2, fixture.auth.prompts.size());
        assertEquals(0, clearing.settlements);
        fixture.authenticateAndComplete();
        assertSuccess(reading, "new");
        fixture.runWorker();
        assertSuccess(clearing, null);
        fixture.runWorker();
        assertSuccess(missing, null);
        assertEquals(1, fixture.store.clearCalls);
        assertTrue(fixture.store.values.isEmpty());
        assertEquals(2, fixture.auth.prompts.size());
    }

    @Test
    public void cancellingAQueuedRequestDoesNotPrepareItOrCancelTheCurrentPrompt() {
        Fixture fixture = new Fixture();
        RecordingResult active = fixture.set("entry", "kept", "active");
        fixture.runWorker();
        RecordingResult cancelled = fixture.set("entry", "discarded", "queued");
        RecordingResult next = fixture.get("entry", "next");
        fixture.controller.cancel("queued");
        fixture.controller.cancel("queued");
        assertFailure(cancelled, "CANCELLED");
        assertFailure(fixture.get("entry", "queued"), "CANCELLED");
        assertEquals(0, fixture.auth.latest().cancelCalls);
        assertEquals(1, fixture.store.setCalls);
        fixture.authenticateAndComplete();
        assertSuccess(active, null);
        fixture.runWorker();
        fixture.authenticateAndComplete();
        assertSuccess(next, "kept");
        assertEquals(1, fixture.store.setCalls);
    }

    @Test
    public void backgroundRejectsEveryQueuedOperationAndDoesNotReviveItOnResume() {
        Fixture fixture = new Fixture();
        RecordingResult active = fixture.set("entry", "active", "active");
        fixture.runWorker();
        RecordingResult writing = fixture.set("entry", "queued", "queued-set");
        RecordingResult reading = fixture.get("entry", "queued-get");
        RecordingResult removing = fixture.remove("entry");
        RecordingResult clearing = fixture.clear();
        fixture.controller.setForeground(false);
        for (RecordingResult result : new RecordingResult[] { writing, reading, removing, clearing }) {
            assertFailure(result, "APP_INACTIVE");
        }
        fixture.controller.setForeground(true);
        assertFailure(fixture.get("entry", "queued-get"), "CANCELLED");
        fixture.auth.latest().fail("CANCELLED");
        fixture.control.runAll();
        fixture.runWorker();
        fixture.runWorker();
        assertFailure(active, "APP_INACTIVE");
        assertEquals(1, fixture.store.setCalls);
        assertEquals(0, fixture.store.getCalls);
        assertEquals(0, fixture.store.removeCalls);
        assertEquals(0, fixture.store.clearCalls);
    }

    @Test
    public void backgroundAfterWriteCommitPreservesSuccessButRejectsTheQueue() {
        Fixture fixture = new Fixture();
        RecordingResult active = fixture.set("entry", "new", "active");
        RecordingResult clearing = fixture.clear();
        fixture.runWorker();
        fixture.auth.latest().succeed();
        fixture.control.runAll();
        fixture.worker.runAll();
        fixture.controller.setForeground(false);
        assertFailure(clearing, "APP_INACTIVE");
        fixture.control.runAll();
        assertSuccess(active, null);
        assertEquals("new", fixture.store.values.get("entry"));
        assertEquals(0, fixture.store.clearCalls);
    }

    @Test
    public void destroyLetsAnActiveClearFinishAfterRejectingQueuedOperations() {
        Fixture fixture = new Fixture();
        fixture.store.values.put("entry", "old");
        RecordingResult clearing = fixture.clear();
        RecordingResult queued = fixture.set("entry", "new", "queued");
        int[] destroyed = { 0 };
        clearing.afterSettlement = () -> assertEquals(0, destroyed[0]);
        fixture.controller.destroy(() -> destroyed[0]++);
        assertFailure(queued, "APP_INACTIVE");
        assertEquals(0, clearing.settlements);
        assertEquals(0, destroyed[0]);
        fixture.runWorker();
        assertSuccess(clearing, null);
        assertEquals(1, destroyed[0]);
        assertEquals(0, fixture.store.setCalls);
        assertTrue(fixture.store.values.isEmpty());
    }

    @Test
    public void clearErrorsAdvanceToTheNextQueuedOperation() {
        for (boolean checked : new boolean[] { true, false }) {
            Fixture fixture = new Fixture();
            fixture.store.clearFailure = checked ? failure("DATA_CORRUPTED") : null;
            fixture.store.clearRuntimeFailure = checked ? null : new IllegalStateException("Clear failed");
            RecordingResult clearing = fixture.clear();
            RecordingResult next = fixture.get("missing", "next");
            fixture.runWorker();
            assertFailure(clearing, checked ? "DATA_CORRUPTED" : "IO_ERROR");
            fixture.runWorker();
            assertSuccess(next, null);
        }
    }

    @Test
    public void resultCallbackReentryCannotStartWorkEarlyOrJumpTheQueue() {
        Fixture fixture = new Fixture();
        RecordingResult first = fixture.set("entry", "value", "first");
        RecordingResult second = fixture.get("entry", "second");
        RecordingResult[] third = new RecordingResult[1];
        first.afterSettlement = () -> {
            assertEquals(1, fixture.store.latest().closeCalls);
            fixture.controller.cancel("first");
            third[0] = fixture.clear();
            assertTrue(fixture.worker.tasks.isEmpty());
            assertEquals(0, fixture.store.getCalls);
        };
        fixture.runWorker();
        fixture.authenticateAndComplete();
        assertSuccess(first, null);
        fixture.runWorker();
        fixture.authenticateAndComplete();
        assertSuccess(second, "value");
        fixture.runWorker();
        assertSuccess(third[0], null);
        assertTrue(fixture.store.values.isEmpty());
    }

    @Test
    public void reentrantResumeDuringBackgroundRejectionCannotReviveAbandonedRequests() {
        Fixture fixture = new Fixture();
        RecordingResult active = fixture.remove("entry");
        RecordingResult first = fixture.get("entry", "abandoned-first");
        RecordingResult second = fixture.clear();
        RecordingResult[] resumed = new RecordingResult[1];
        first.afterSettlement = () -> {
            fixture.controller.setForeground(true);
            resumed[0] = fixture.get("missing", "resumed");
        };
        fixture.controller.setForeground(false);
        assertFailure(first, "APP_INACTIVE");
        assertFailure(second, "APP_INACTIVE");
        fixture.runWorker();
        assertSuccess(active, null);
        fixture.runWorker();
        assertSuccess(resumed[0], null);
        assertEquals(1, fixture.store.getCalls);
        assertEquals(0, fixture.store.clearCalls);
    }

    @Test
    public void destroyFromResultCallbackRejectsQueuedWorkBeforeNotifyingIdle() {
        Fixture fixture = new Fixture();
        RecordingResult first = fixture.get("missing", "first");
        RecordingResult queued = fixture.clear();
        int[] destroyed = { 0 };
        first.afterSettlement = () -> {
            fixture.controller.destroy(() -> destroyed[0]++);
            assertFailure(queued, "APP_INACTIVE");
            assertEquals(0, destroyed[0]);
        };
        fixture.runWorker();
        assertSuccess(first, null);
        assertEquals(1, destroyed[0]);
        assertEquals(0, fixture.store.clearCalls);
        assertTrue(fixture.worker.tasks.isEmpty());
    }

    private static void assertSuccess(RecordingResult result, String value) {
        assertEquals(1, result.settlements);
        assertNull(result.error);
        assertEquals(value, result.value);
    }

    private static void assertFailure(RecordingResult result, String code) {
        assertEquals(1, result.settlements);
        assertNotNull(result.error);
        assertEquals(code, result.error.code());
        assertNull(result.value);
    }

    private static VaultException failure(String code) {
        return new VaultException(code, "Controlled test failure");
    }

    private static Cipher newCipher() {
        try {
            return Cipher.getInstance("AES/GCM/NoPadding");
        } catch (GeneralSecurityException exception) {
            throw new AssertionError(exception);
        }
    }

    private static final class RecordingResult implements VaultController.Result {
        int settlements;
        String value;
        VaultException error;
        Runnable afterSettlement = () -> {};

        @Override
        public void resolve(String value) {
            settlements++;
            this.value = value;
            afterSettlement.run();
        }

        @Override
        public void reject(VaultException error) {
            settlements++;
            this.error = error;
            afterSettlement.run();
        }
    }

    private static final class QueueExecutor implements Executor {
        final Queue<Runnable> tasks = new ArrayDeque<>();

        @Override
        public void execute(Runnable action) {
            tasks.add(action);
        }

        void runAll() {
            while (!tasks.isEmpty()) {
                tasks.remove().run();
            }
        }
    }

    private static final class FakeStore implements VaultController.Store {
        final Map<String, String> values = new HashMap<>();
        final List<FakePrepared> preparations = new ArrayList<>();
        VaultException prepareFailure;
        RuntimeException prepareRuntimeFailure;
        VaultException removeFailure;
        VaultException clearFailure;
        RuntimeException clearRuntimeFailure;
        int setCalls;
        int getCalls;
        int removeCalls;
        int clearCalls;

        @Override
        public VaultController.Prepared prepareSet(String id, String value) throws VaultException {
            setCalls++;
            checkPreparation();
            FakePrepared prepared = new FakePrepared(this, id, value, true);
            preparations.add(prepared);
            return prepared;
        }

        @Override
        public VaultController.Prepared prepareGet(String id) throws VaultException {
            getCalls++;
            checkPreparation();
            if (!values.containsKey(id)) {
                return null;
            }
            FakePrepared prepared = new FakePrepared(this, id, values.get(id), false);
            preparations.add(prepared);
            return prepared;
        }

        private void checkPreparation() throws VaultException {
            if (prepareFailure != null) {
                throw prepareFailure;
            }
            if (prepareRuntimeFailure != null) {
                throw prepareRuntimeFailure;
            }
        }

        @Override
        public void remove(String id) throws VaultException {
            removeCalls++;
            if (removeFailure != null) {
                throw removeFailure;
            }
            values.remove(id);
        }

        @Override
        public void clear() throws VaultException {
            clearCalls++;
            if (clearFailure != null) {
                throw clearFailure;
            }
            if (clearRuntimeFailure != null) {
                throw clearRuntimeFailure;
            }
            values.clear();
        }

        FakePrepared latest() {
            return preparations.get(preparations.size() - 1);
        }
    }

    private static final class FakePrepared implements VaultController.Prepared {
        final FakeStore store;
        final String id;
        final String value;
        final boolean writing;
        final Cipher cipher = newCipher();
        int completeCalls;
        int closeCalls;
        VaultException completeFailure;
        RuntimeException completeRuntimeFailure;
        RuntimeException closeRuntimeFailure;
        VaultException commitFailure;
        Runnable beforeCommit = () -> {};

        FakePrepared(FakeStore store, String id, String value, boolean writing) {
            this.store = store;
            this.id = id;
            this.value = value;
            this.writing = writing;
        }

        @Override
        public Cipher cipher() {
            return cipher;
        }

        @Override
        public String complete(VaultController.CommitGate gate) throws VaultException {
            completeCalls++;
            if (completeFailure != null) {
                throw completeFailure;
            }
            if (completeRuntimeFailure != null) {
                throw completeRuntimeFailure;
            }
            if (writing) {
                beforeCommit.run();
                gate.commit(() -> {
                    if (commitFailure != null) {
                        throw commitFailure;
                    }
                    store.values.put(id, value);
                });
                return null;
            }
            return value;
        }

        @Override
        public void close() {
            closeCalls++;
            if (closeRuntimeFailure != null) {
                throw closeRuntimeFailure;
            }
        }
    }

    private static final class FakeAuthenticator implements VaultController.Authenticator {
        final List<FakePrompt> prompts = new ArrayList<>();
        VaultException startFailure;
        RuntimeException startRuntimeFailure;

        @Override
        public VaultController.Authentication authenticate(Cipher cipher, String reason,
            VaultController.AuthenticationCallback callback) throws VaultException {
            if (startFailure != null) {
                throw startFailure;
            }
            if (startRuntimeFailure != null) {
                throw startRuntimeFailure;
            }
            FakePrompt prompt = new FakePrompt(cipher, reason, callback);
            prompts.add(prompt);
            return prompt;
        }

        FakePrompt latest() {
            return prompts.get(prompts.size() - 1);
        }
    }

    private static final class FakePrompt implements VaultController.Authentication {
        final Cipher cipher;
        final String reason;
        final VaultController.AuthenticationCallback callback;
        int cancelCalls;

        FakePrompt(Cipher cipher, String reason, VaultController.AuthenticationCallback callback) {
            this.cipher = cipher;
            this.reason = reason;
            this.callback = callback;
        }

        void succeed() {
            callback.authenticated(cipher);
        }

        void fail(String code) {
            callback.failed(failure(code));
        }

        @Override
        public void cancel() {
            cancelCalls++;
        }
    }

    private static final class Fixture {
        final FakeStore store = new FakeStore();
        final FakeAuthenticator auth = new FakeAuthenticator();
        final QueueExecutor control = new QueueExecutor();
        final QueueExecutor worker = new QueueExecutor();
        final VaultController controller = new VaultController(store, auth, control, worker);

        Fixture() {
            controller.setForeground(true);
        }

        RecordingResult set(String id, String value, String requestId) {
            RecordingResult result = new RecordingResult();
            controller.set(id, value, requestId, "Save or read this entry", result);
            return result;
        }

        RecordingResult get(String id, String requestId) {
            RecordingResult result = new RecordingResult();
            controller.get(id, requestId, "Save or read this entry", result);
            return result;
        }

        RecordingResult remove(String id) {
            RecordingResult result = new RecordingResult();
            controller.remove(id, result);
            return result;
        }

        RecordingResult clear() {
            RecordingResult result = new RecordingResult();
            controller.clear(result);
            return result;
        }

        void runWorker() {
            worker.runAll();
            control.runAll();
        }

        void authenticateAndComplete() {
            auth.latest().succeed();
            control.runAll();
            runWorker();
        }
    }
}
