package app.monoid.plugins.isodepnfc;

import static org.junit.Assert.*;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class SessionControllerTest {
    private static final byte[] COMMAND = { 0, (byte) 0xA4, 4, 0 };
    private static final byte[] RESPONSE = { 1, 2, 0x61, 0 };

    @Test
    public void scanningStartsImmediatelyHasNoIdleDeadlineAndIsExclusive() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("scan"));
        assertTrue(fixture.scheduler.actions.isEmpty());
        assertTrue(fixture.events.opened.isEmpty());
        assertFailure(fixture.start("other"), "BUSY", null);
        assertEquals(1, fixture.reader.startCalls);

        assertSuccess(fixture.stop("scan"));
        assertEquals(1, fixture.reader.stopCalls);
        assertEvent(fixture.events.scans.get(0), "scan", null, "stopped", null);
        assertFailure(fixture.start("scan"), "SCAN_CLOSED", null);
    }

    @Test
    public void stopBeforeStartRetiresOnlyThatScanId() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.stop("cancelled"));
        assertFailure(fixture.start("cancelled"), "SCAN_CLOSED", null);
        assertSuccess(fixture.start("active"));
        assertSuccess(fixture.stop("unrelated"));
        assertSuccess(fixture.close("unknown-session"));
        assertEquals(0, fixture.reader.stopCalls);
        fixture.connect(new FakeTransport());
        assertEquals(1, fixture.events.opened.size());
    }

    @Test
    public void initialPageStartWithoutAScanDoesNotTouchTheReader() {
        Fixture fixture = new Fixture();
        fixture.page.pageStarted();
        fixture.bridge.runAll();
        fixture.finishCleanup();
        assertEquals(0, fixture.reader.startCalls);
        assertEquals(0, fixture.reader.stopCalls);
        assertTrue(fixture.events.opened.isEmpty());
        assertTrue(fixture.events.ended.isEmpty());
        assertTrue(fixture.events.scans.isEmpty());
        assertTrue(fixture.scheduler.actions.isEmpty());
        assertSuccess(fixture.start("first-page"));
    }

    @Test
    public void pageStartEndsTheOldScanAndSessionBeforeAllowingANewScan() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String oldSession = fixture.startAndConnect(transport);
        SessionController.TagCallback oldDiscovery = fixture.reader.onTag;
        fixture.page.pageStarted();
        fixture.page.pageStarted();
        fixture.bridge.runAll();

        assertEvent(fixture.events.ended.get(0), "scan", oldSession, "page-reloaded", "APP_INACTIVE");
        assertEvent(fixture.events.scans.get(0), "scan", null, "page-reloaded", "APP_INACTIVE");
        assertEquals(1, fixture.events.ended.size());
        assertEquals(1, fixture.events.scans.size());
        assertFailure(fixture.start("next"), "BUSY", null);
        assertFailure(fixture.start("scan"), "SCAN_CLOSED", null);
        assertFailure(fixture.exchange(oldSession, null), "SESSION_CLOSED", "not-sent");
        fixture.finishCleanup();
        assertEquals(1, transport.closeCalls);
        assertEquals(1, fixture.reader.stopCalls);

        assertSuccess(fixture.start("next"));
        FakeTransport staleTag = new FakeTransport();
        oldDiscovery.accept(staleTag);
        fixture.control.runAll();
        fixture.connect(new FakeTransport());
        String nextSession = fixture.events.lastSessionId();
        assertNotEquals(oldSession, nextSession);
        assertEquals(0, staleTag.connectCalls);
        assertSuccess(fixture.stop("scan"));
        assertSuccess(fixture.close(oldSession));
        assertFailure(fixture.exchange(oldSession, null), "SESSION_CLOSED", "not-sent");
        RecordingResult<byte[]> nextExchange = fixture.exchange(nextSession, null);
        fixture.finishExchange();
        assertSuccess(nextExchange);
        assertArrayEquals(RESPONSE, nextExchange.value);
        assertEquals(1, fixture.reader.stopCalls);
        assertEquals(2, fixture.events.opened.size());
    }

    @Test
    public void pageStartRetainsUnknownOutcomeAndDiscardsALateExchangeReply() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<byte[]> exchange = fixture.exchange(sessionId, null);
        fixture.io.runAll(); // Sent, but its native completion is still queued.
        fixture.page.pageStarted();
        assertFailure(exchange, "APP_INACTIVE", "unknown");
        fixture.control.runAll();
        fixture.finishCleanup();
        assertEquals(1, exchange.settlements);
        assertEquals(1, transport.transceiveCalls);
        assertSuccess(fixture.start("next"));
        fixture.connect(new FakeTransport());
        assertEquals(2, fixture.events.opened.size());
    }

    @Test
    public void pageStartDropsOldBridgeCallsAndResultsBeforeAcceptingNewDocumentWork() {
        Fixture fixture = new Fixture();
        String sessionId = fixture.startAndConnect(new FakeTransport());
        Object oldDocument = fixture.page.currentDocument();
        RecordingResult<byte[]> oldReply = new RecordingResult<>();
        fixture.controller.transceive(sessionId, COMMAND, null, fixture.page.bind(oldReply));
        fixture.page.dispatch(() -> fail("An old call queued on main must be dropped"));
        fixture.page.pageStarted();
        assertFalse(fixture.page.isCurrent(oldDocument));
        // This represents an old call still on Capacitor's queue at page start.
        fixture.page.dispatch(() -> fail("An old call queued on the bridge must be dropped"));
        fixture.control.runAll();
        fixture.finishExchange();
        fixture.finishCleanup();
        assertEquals(0, oldReply.settlements);

        fixture.bridge.runAll();
        RecordingResult<Void> nextStart = new RecordingResult<>();
        fixture.page.dispatch(() -> fixture.controller.startScan("next", 1000, fixture.page.bind(nextStart)));
        fixture.control.runAll();
        assertSuccess(nextStart);
        assertTrue(fixture.page.isCurrent(fixture.page.currentDocument()));

        Fixture closing = new Fixture();
        String closingSession = closing.startAndConnect(new FakeTransport());
        RecordingResult<Void> oldClose = new RecordingResult<>();
        closing.controller.close(closingSession, closing.page.bind(oldClose));
        closing.page.pageStarted();
        closing.finishCleanup();
        assertEquals(0, oldClose.settlements);
    }

    @Test
    public void pageStartAfterDestroyCannotReopenTheScopeOrAffectCleanup() {
        Fixture fixture = new Fixture();
        fixture.startAndConnect(new FakeTransport());
        Object document = fixture.page.currentDocument();
        fixture.page.destroy();
        fixture.page.pageStarted();
        fixture.bridge.runAll();
        fixture.page.dispatch(() -> fail("Destroyed plugins cannot accept calls"));
        fixture.finishCleanup();
        assertFalse(fixture.page.isCurrent(document));
        assertTrue(fixture.bridge.tasks.isEmpty());
        assertEquals(1, fixture.reader.stopCalls);
        assertEquals("destroyed", fixture.events.scans.get(0).reason);
        assertEquals(1, fixture.events.scans.size());
    }

    @Test
    public void successiveDiscoveriesWithTheSameUidGetNewSessionsWithoutRestartingTheReader() {
        Fixture fixture = new Fixture();
        FakeTransport first = new FakeTransport();
        String firstId = fixture.startAndConnect(first);
        assertEquals(firstId, UUID.fromString(firstId).toString());
        RecordingResult<Void> firstClose = fixture.close(firstId);
        fixture.finishCleanup();
        assertSuccess(firstClose);

        // Completing close never reuses the old tag without a discovery event.
        fixture.finishExchange();
        assertEquals(1, fixture.events.opened.size());
        assertEquals(1, first.connectCalls);
        assertFailure(fixture.exchange(firstId, null), "SESSION_CLOSED", "not-sent");

        fixture.connect(new FakeTransport());
        String secondId = fixture.events.lastSessionId();
        assertNotEquals(firstId, secondId);
        assertArrayEquals(fixture.events.opened.get(0).tag.identifier,
            fixture.events.opened.get(1).tag.identifier);
        RecordingResult<Void> secondClose = fixture.close(secondId);
        fixture.finishCleanup();
        assertSuccess(secondClose);
        assertEquals(1, fixture.reader.startCalls);
        assertEquals(0, fixture.reader.stopCalls);
        assertTrue(fixture.events.scans.isEmpty());
        assertEvent(fixture.events.ended.get(0), "scan", firstId, "closed", null);
        assertEvent(fixture.events.ended.get(1), "scan", secondId, "closed", null);
    }

    @Test
    public void removalWaitClosesTransportButRejectsDiscoveriesUntilRemoval() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<Void> waiting = fixture.waitForRemoval(sessionId);
        RecordingResult<Void> alsoWaiting = fixture.waitForRemoval(sessionId);
        fixture.finishCleanup();

        assertEquals(1, transport.closeCalls);
        assertEquals(1, fixture.reader.removalCalls);
        assertEquals(0, waiting.settlements);
        assertSuccess(fixture.close(sessionId));
        FakeTransport heldCard = new FakeTransport();
        fixture.connect(heldCard);
        assertEquals(0, heldCard.connectCalls);
        assertEquals(1, fixture.events.opened.size());

        fixture.reader.removal.resolve(null);
        fixture.control.runAll();
        assertSuccess(waiting);
        assertSuccess(alsoWaiting);
        assertSuccess(fixture.waitForRemoval(sessionId));
        fixture.connect(new FakeTransport());
        assertEquals(2, fixture.events.opened.size());
    }

    @Test
    public void failedExchangeKeepsDiscoveryReservedUntilTheCallerChoosesRemoval() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        transport.exchangeFailure = "IO_ERROR";
        fixture.exchange(sessionId, null);
        fixture.finishExchange();
        fixture.finishCleanup();
        FakeTransport rediscovered = new FakeTransport();
        fixture.connect(rediscovered);
        assertEquals(0, rediscovered.connectCalls);

        RecordingResult<Void> waiting = fixture.waitForRemoval(sessionId);
        assertEquals(0, waiting.settlements);
        assertEquals(1, fixture.reader.removalCalls);
        fixture.reader.removal.resolve(null);
        fixture.control.runAll();
        assertSuccess(waiting);
    }

    @Test
    public void detectedTagLossSatisfiesRemovalAfterTransportCleanup() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        transport.exchangeFailure = "TAG_LOST";
        fixture.exchange(sessionId, null);
        fixture.finishExchange();
        RecordingResult<Void> waiting = fixture.waitForRemoval(sessionId);
        assertEquals(0, waiting.settlements);
        fixture.finishCleanup();
        assertSuccess(waiting);
        assertEquals(0, fixture.reader.removalCalls);
    }

    @Test
    public void endingTheScanCancelsRemovalAndOldCallbacksCannotReleaseANewSession() {
        for (String[] termination : new String[][] {
            {"stopped", "CANCELLED"}, {"app-paused", "APP_INACTIVE"},
            {"destroyed", "APP_INACTIVE"}, {"page-reloaded", "APP_INACTIVE"}, {"nfc-disabled", "NFC_DISABLED"}
        }) {
            Fixture fixture = new Fixture();
            String sessionId = fixture.startAndConnect(new FakeTransport());
            RecordingResult<Void> waiting = fixture.waitForRemoval(sessionId);
            fixture.finishCleanup();
            SessionController.Result<Void> oldRemoval = fixture.reader.removal;
            if (termination[0].equals("stopped")) {
                assertSuccess(fixture.stop("scan"));
            } else {
                fixture.controller.terminate(termination[0], termination[1]);
            }
            assertFailure(waiting, termination[1], null);
            assertEquals(1, fixture.reader.stopCalls);

            assertSuccess(fixture.start("next"));
            fixture.connect(new FakeTransport());
            String nextSession = fixture.events.lastSessionId();
            RecordingResult<Void> nextWaiting = fixture.waitForRemoval(nextSession);
            fixture.finishCleanup();
            oldRemoval.resolve(null);
            fixture.control.runAll();
            assertEquals(0, nextWaiting.settlements);
            assertEquals(1, waiting.settlements);
            fixture.reader.removal.resolve(null);
            fixture.control.runAll();
            assertSuccess(nextWaiting);
        }
    }

    @Test
    public void stoppingBeforeCleanupCancelsRemovalWithoutStartingADetector() {
        Fixture fixture = new Fixture();
        String sessionId = fixture.startAndConnect(new FakeTransport());
        RecordingResult<Void> waiting = fixture.waitForRemoval(sessionId);
        RecordingResult<Void> stopped = fixture.stop("scan");
        fixture.finishCleanup();
        assertSuccess(stopped);
        assertFailure(waiting, "CANCELLED", null);
        assertEquals(0, fixture.reader.removalCalls);
    }

    @Test
    public void removalDetectionFailureStopsTheScanInsteadOfPermittingRetry() {
        for (String code : Arrays.asList("IO_ERROR", "UNSUPPORTED")) {
            Fixture fixture = new Fixture();
            String sessionId = fixture.startAndConnect(new FakeTransport());
            RecordingResult<Void> waiting = fixture.waitForRemoval(sessionId);
            fixture.finishCleanup();
            fixture.reader.removal.reject(new SessionController.Failure(code,
                "Unable to confirm removal.", null, null));
            fixture.control.runAll();
            assertFailure(waiting, code, null);
            assertEquals(1, fixture.reader.stopCalls);
            FakeTransport heldCard = new FakeTransport();
            fixture.connect(heldCard);
            assertEquals(0, heldCard.connectCalls);
            assertSuccess(fixture.stop("scan"));
        }
    }

    @Test
    public void unknownRemovalWaitCannotPretendTheCardWasRemoved() {
        Fixture fixture = new Fixture();
        assertFailure(fixture.waitForRemoval("unknown"), "SESSION_CLOSED", null);
        String sessionId = fixture.startAndConnect(new FakeTransport());
        fixture.close(sessionId);
        fixture.finishCleanup();
        assertFailure(fixture.waitForRemoval(sessionId), "SESSION_CLOSED", null);
    }

    @Test
    public void discoveriesDuringReservationConnectionSessionAndCleanupAreDiscarded() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("scan"));
        FakeTransport selected = new FakeTransport();
        FakeTransport reserved = new FakeTransport();
        FakeTransport connecting = new FakeTransport();
        FakeTransport connected = new FakeTransport();
        FakeTransport closing = new FakeTransport();
        fixture.reader.onTag.accept(selected);
        fixture.reader.onTag.accept(reserved);
        assertEquals(1, fixture.control.tasks.size());
        fixture.control.runAll();
        fixture.reader.onTag.accept(connecting);
        fixture.finishExchange();
        fixture.reader.onTag.accept(connected);
        RecordingResult<Void> closed = fixture.close(fixture.events.lastSessionId());
        fixture.reader.onTag.accept(closing);
        fixture.finishCleanup();
        fixture.finishExchange();

        assertSuccess(closed);
        assertEquals(1, fixture.events.opened.size());
        for (FakeTransport dropped : Arrays.asList(reserved, connecting, connected, closing)) {
            assertEquals(0, dropped.connectCalls);
        }
        fixture.connect(new FakeTransport());
        assertEquals(2, fixture.events.opened.size());
    }

    @Test
    public void aDiscoveryQueuedBeforeStopCannotConnectOrAttachToANewScan() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("old"));
        SessionController.TagCallback oldDiscovery = fixture.reader.onTag;
        FakeTransport queued = new FakeTransport();
        oldDiscovery.accept(queued);
        assertSuccess(fixture.stop("old"));
        assertSuccess(fixture.start("new"));
        FakeTransport late = new FakeTransport();
        oldDiscovery.accept(late);
        fixture.control.runAll();
        fixture.finishExchange();

        assertEquals(0, queued.connectCalls);
        assertEquals(0, late.connectCalls);
        assertTrue(fixture.events.ended.isEmpty());
        fixture.connect(new FakeTransport());
        assertEquals("new", fixture.events.opened.get(0).scanId);
    }

    @Test
    public void stoppingAQueuedConnectWaitsForItsWorkerWithoutConnecting() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("scan"));
        FakeTransport transport = new FakeTransport();
        fixture.reader.onTag.accept(transport);
        fixture.control.runAll();
        RecordingResult<Void> stopping = fixture.stop("scan");
        RecordingResult<Void> secondStop = fixture.stop("scan");
        assertFailure(fixture.start("next"), "BUSY", null);
        fixture.finishCleanup();
        assertEquals(0, stopping.settlements);
        fixture.finishExchange();

        assertSuccess(stopping);
        assertSuccess(secondStop);
        assertEquals(0, transport.connectCalls);
        assertTrue(fixture.events.opened.isEmpty());
        assertEquals(1, fixture.events.ended.size());
        assertEvent(fixture.events.ended.get(0), "scan", fixture.events.ended.get(0).sessionId,
            "scan-stopped", null);
        assertEquals(1, fixture.reader.stopCalls);
        assertSuccess(fixture.start("next"));
    }

    @Test
    public void aQueuedExchangeIsCancelledBeforeSendingAndCloseWaitsForCleanup() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<byte[]> exchange = fixture.exchange(sessionId, null);
        RecordingResult<Void> closing = fixture.close(sessionId);
        assertFailure(exchange, "CANCELLED", "not-sent");
        fixture.finishCleanup();
        assertEquals(0, closing.settlements);
        FakeTransport premature = new FakeTransport();
        fixture.reader.onTag.accept(premature);
        fixture.finishExchange();

        assertSuccess(closing);
        assertEquals(0, transport.transceiveCalls);
        assertEquals(0, premature.connectCalls);
        assertEquals(1, exchange.settlements);
        assertEquals(0, fixture.reader.stopCalls);
    }

    @Test
    public void stopKeepsTheReaderUntilBothTheWorkerAndConnectionCleanupFinish() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<byte[]> exchange = fixture.exchange(sessionId, null);
        RecordingResult<Void> stopping = fixture.stop("scan");

        assertFailure(exchange, "CANCELLED", "not-sent");
        assertEquals(1, fixture.events.ended.size());
        assertEquals(1, fixture.events.scans.size());
        assertEquals(0, fixture.reader.stopCalls);
        assertEquals(0, stopping.settlements);
        fixture.finishCleanup();
        assertEquals(1, transport.closeCalls);
        assertEquals(0, fixture.reader.stopCalls);
        assertEquals(0, stopping.settlements);
        FakeTransport dropped = new FakeTransport();
        fixture.reader.onTag.accept(dropped);
        fixture.finishExchange();

        assertSuccess(stopping);
        assertEquals(0, transport.transceiveCalls);
        assertEquals(0, dropped.connectCalls);
        assertEquals(2, transport.closeCalls);
        assertEquals(1, fixture.reader.stopCalls);
        assertSuccess(fixture.stop("scan"));
        assertEquals(1, fixture.reader.stopCalls);
    }

    @Test
    public void stoppingAfterSessionCleanupStillStopsTheReaderExactlyOnce() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<Void> closed = fixture.close(sessionId);
        fixture.finishCleanup();
        assertSuccess(closed);
        assertEquals(0, fixture.reader.stopCalls);

        assertSuccess(fixture.stop("scan"));
        assertSuccess(fixture.stop("scan"));
        assertEquals(1, fixture.reader.stopCalls);
        assertEquals(1, transport.closeCalls);
        assertEquals(1, fixture.events.ended.size());
        assertEquals(1, fixture.events.scans.size());
    }

    @Test
    public void reentrantStopDuringReaderCleanupSharesTheFinalFailure() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("scan"));
        RecordingResult<Void> reentrant = new RecordingResult<>();
        fixture.reader.onStop = () -> {
            fixture.controller.stopScan("scan", reentrant);
            assertEquals(0, reentrant.settlements);
            assertFailure(fixture.start("next"), "BUSY", null);
        };
        fixture.reader.stopFailure = true;
        RecordingResult<Void> stopping = fixture.stop("scan");

        assertFailure(stopping, "IO_ERROR", null);
        assertFailure(reentrant, "IO_ERROR", null);
        assertEquals(1, fixture.reader.stopCalls);
        assertEquals(1, fixture.events.scans.size());
    }

    @Test
    public void completionQueuedAfterCloseCannotResolveAnExchangeTwice() {
        Fixture fixture = new Fixture();
        String sessionId = fixture.startAndConnect(new FakeTransport());
        RecordingResult<byte[]> exchange = fixture.exchange(sessionId, null);
        ScheduledAction deadline = fixture.scheduler.latest();
        fixture.io.runAll(); // The card returned, but control has not received the result.
        RecordingResult<Void> closed = fixture.close(sessionId);
        assertFailure(exchange, "CANCELLED", "unknown");
        fixture.control.runAll();
        fixture.finishCleanup();
        assertSuccess(closed);
        fixture.connect(new FakeTransport());
        deadline.action.run();
        assertEquals(1, exchange.settlements);
        assertEquals(1, fixture.events.ended.size());
        assertEquals(2, fixture.events.opened.size());
    }

    @Test
    public void onlyOneExchangeRunsAndTimeoutOverridesDoNotChangeTheScanDefault() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<byte[]> overridden = fixture.exchange(sessionId, 250);
        assertFailure(fixture.exchange(sessionId, null), "BUSY", "not-sent");
        assertEquals(250, fixture.scheduler.latest().delayMs);
        fixture.finishExchange();
        assertSuccess(overridden);
        assertArrayEquals(RESPONSE, overridden.value);
        RecordingResult<byte[]> normal = fixture.exchange(sessionId, null);
        assertEquals(Fixture.DEFAULT_TIMEOUT, fixture.scheduler.latest().delayMs);
        fixture.finishExchange();

        assertSuccess(normal);
        assertEquals(Arrays.asList(250, Fixture.DEFAULT_TIMEOUT), transport.timeouts);
        assertEquals(2, transport.transceiveCalls);
        assertTrue(fixture.events.ended.isEmpty());
    }

    @Test
    public void requestsAreSnapshottedAndOversizedCommandsDoNotReachTheCard() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<byte[]> oversized = new RecordingResult<>();
        fixture.controller.transceive(sessionId, new byte[262], null, oversized);
        assertFailure(oversized, "DATA_TOO_LARGE", "not-sent");
        byte[] request = COMMAND.clone();
        RecordingResult<byte[]> exchange = new RecordingResult<>();
        fixture.controller.transceive(sessionId, request, null, exchange);
        request[0] = 42;
        fixture.finishExchange();

        assertSuccess(exchange);
        assertArrayEquals(COMMAND, transport.lastRequest);
        assertEquals(1, transport.transceiveCalls);
        assertTrue(fixture.events.ended.isEmpty());
    }

    @Test
    public void settingTheTimeoutCanFailWithoutSendingTheCommand() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        transport.timeoutFailure = new IllegalArgumentException("Unsupported timeout");
        RecordingResult<byte[]> exchange = fixture.exchange(sessionId, 250);
        fixture.finishExchange();
        fixture.finishCleanup();

        assertFailure(exchange, "IO_ERROR", "not-sent");
        assertEquals(0, transport.transceiveCalls);
        assertEvent(fixture.events.ended.get(0), "scan", sessionId, "io-error", "IO_ERROR");
        assertTrue(fixture.events.scans.isEmpty());
    }

    @Test
    public void transportFailureHasUnknownOutcomeAndDoesNotRetryTheCommand() {
        for (String code : Arrays.asList("TAG_LOST", "IO_ERROR")) {
            Fixture fixture = new Fixture();
            FakeTransport transport = new FakeTransport();
            String sessionId = fixture.startAndConnect(transport);
            transport.exchangeFailure = code;
            RecordingResult<byte[]> exchange = fixture.exchange(sessionId, null);
            fixture.finishExchange();
            fixture.finishCleanup();

            assertFailure(exchange, code, "unknown");
            assertEquals(1, transport.transceiveCalls);
            assertEvent(fixture.events.ended.get(0), "scan", sessionId,
                code.equals("TAG_LOST") ? "tag-lost" : "io-error", code);
            assertEquals(0, fixture.reader.stopCalls);
            assertSuccess(fixture.close(sessionId));
            fixture.connect(new FakeTransport());
            assertEquals(2, fixture.events.opened.size());
        }
    }

    @Test
    public void failedConnectReportsAnEndedSessionAndWaitsForAFreshDiscovery() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("scan"));
        FakeTransport failed = new FakeTransport();
        failed.connectFailure = "TAG_LOST";
        fixture.connect(failed);
        fixture.finishCleanup();

        assertTrue(fixture.events.opened.isEmpty());
        assertEquals(1, fixture.events.ended.size());
        EndedEvent ended = fixture.events.ended.get(0);
        assertNotNull(UUID.fromString(ended.sessionId));
        assertEvent(ended, "scan", ended.sessionId, "tag-lost", "TAG_LOST");
        assertEquals(1, failed.connectCalls);
        assertEquals(0, fixture.reader.stopCalls);
        assertSuccess(fixture.close(ended.sessionId));
        fixture.connect(new FakeTransport());
        assertEquals(1, fixture.events.opened.size());
        assertNotEquals(ended.sessionId, fixture.events.lastSessionId());
    }

    @Test
    public void theConnectionDeadlineStartsAtDiscoveryAndCannotEndALaterSession() {
        Fixture fixture = new Fixture();
        assertSuccess(fixture.start("scan"));
        assertTrue(fixture.scheduler.actions.isEmpty());
        FakeTransport expired = new FakeTransport();
        fixture.reader.onTag.accept(expired);
        fixture.control.runAll();
        ScheduledAction deadline = fixture.scheduler.latest();
        assertEquals(30_000, deadline.delayMs);
        deadline.fire();
        fixture.finishCleanup();
        fixture.finishExchange();

        assertEquals(0, expired.connectCalls);
        assertTrue(fixture.events.opened.isEmpty());
        assertEvent(fixture.events.ended.get(0), "scan", fixture.events.ended.get(0).sessionId,
            "connect-timeout", "TIMEOUT");
        assertSuccess(fixture.close(fixture.events.ended.get(0).sessionId));
        fixture.connect(new FakeTransport());
        deadline.action.run();
        assertEquals(1, fixture.events.opened.size());
        assertEquals(1, fixture.events.ended.size());
        assertEquals(0, fixture.reader.stopCalls);
    }

    @Test
    public void successfulExchangeDeadlinesAreCancelledAndCannotAffectANewScan() {
        Fixture fixture = new Fixture();
        String sessionId = fixture.startAndConnect(new FakeTransport());
        ScheduledAction connectDeadline = fixture.scheduler.latest();
        RecordingResult<byte[]> exchange = fixture.exchange(sessionId, null);
        ScheduledAction exchangeDeadline = fixture.scheduler.latest();
        fixture.finishExchange();
        assertSuccess(exchange);
        assertTrue(connectDeadline.cancelled);
        assertTrue(exchangeDeadline.cancelled);
        RecordingResult<Void> stop = fixture.stop("scan");
        fixture.finishCleanup();
        assertSuccess(stop);
        assertSuccess(fixture.start("next"));
        fixture.connect(new FakeTransport());
        connectDeadline.action.run();
        exchangeDeadline.action.run();

        assertEquals(1, exchange.settlements);
        assertEquals(1, fixture.events.ended.size());
        assertEquals(1, fixture.events.scans.size());
        assertEquals("next", fixture.events.opened.get(1).scanId);
    }

    @Test
    public void lifecycleTerminationEndsIdleScansAndPendingExchangesExactlyOnce() {
        for (String[] termination : new String[][] {
            { "background", "APP_INACTIVE" }, { "page-reloaded", "APP_INACTIVE" }, { "nfc-disabled", "NFC_DISABLED" }
        }) {
            Fixture idle = new Fixture();
            assertSuccess(idle.start("idle"));
            idle.controller.terminate(termination[0], termination[1]);
            idle.controller.terminate(termination[0], termination[1]);
            assertEquals(1, idle.reader.stopCalls);
            assertTrue(idle.events.ended.isEmpty());
            assertEvent(idle.events.scans.get(0), "idle", null, termination[0], termination[1]);

            Fixture connected = new Fixture();
            String sessionId = connected.startAndConnect(new FakeTransport());
            RecordingResult<byte[]> exchange = connected.exchange(sessionId, null);
            connected.controller.terminate(termination[0], termination[1]);
            connected.controller.terminate(termination[0], termination[1]);
            connected.finishCleanup();
            connected.finishExchange();
            assertFailure(exchange, termination[1], "not-sent");
            assertEquals(1, connected.reader.stopCalls);
            assertEquals(1, connected.events.ended.size());
            assertEquals(1, connected.events.scans.size());
            assertEvent(connected.events.ended.get(0), "scan", sessionId, termination[0], termination[1]);
            assertSuccess(connected.start("next"));
        }
    }

    @Test
    public void failedCloseRejectsAllClosersAndStopsScanningBeforeAnotherDiscovery() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        transport.closeFailure = true;
        RecordingResult<Void> first = fixture.close(sessionId);
        RecordingResult<Void> second = fixture.close(sessionId);
        fixture.finishCleanup();

        assertFailure(first, "IO_ERROR", null);
        assertFailure(second, "IO_ERROR", null);
        assertEquals(1, fixture.reader.stopCalls);
        assertEvent(fixture.events.scans.get(0), "scan", null, "io-error", "IO_ERROR");
        FakeTransport dropped = new FakeTransport();
        fixture.reader.onTag.accept(dropped);
        fixture.finishExchange();
        assertEquals(0, dropped.connectCalls);
        assertFailure(fixture.start("scan"), "SCAN_CLOSED", null);
    }

    @Test
    public void stopWaitsForTransportCleanupAndReportsReaderOrTransportCloseFailure() {
        for (boolean readerFailure : new boolean[] { true, false }) {
            Fixture fixture = new Fixture();
            FakeTransport transport = new FakeTransport();
            fixture.startAndConnect(transport);
            fixture.reader.stopFailure = readerFailure;
            transport.closeFailure = !readerFailure;
            RecordingResult<Void> stopping = fixture.stop("scan");
            assertEquals(0, stopping.settlements);
            fixture.finishCleanup();

            assertFailure(stopping, "IO_ERROR", null);
            assertEquals(1, transport.closeCalls);
            assertEquals(1, fixture.events.scans.size());
        }
    }

    @Test
    public void readerStartFailureRetiresTheScanAndSettlesTheCallOnce() {
        Fixture fixture = new Fixture();
        fixture.reader.startFailure = true;
        assertFailure(fixture.start("scan"), "IO_ERROR", null);
        assertEquals(1, fixture.reader.stopCalls);
        assertEvent(fixture.events.scans.get(0), "scan", null, "io-error", "IO_ERROR");
        assertFailure(fixture.start("scan"), "SCAN_CLOSED", null);
        fixture.reader.startFailure = false;
        assertSuccess(fixture.start("next"));
    }

    @Test
    public void endedCallbackCanCloseAndStopAgainWithoutBypassingCleanup() {
        Fixture fixture = new Fixture();
        FakeTransport transport = new FakeTransport();
        String sessionId = fixture.startAndConnect(transport);
        RecordingResult<Void> reentrantClose = new RecordingResult<>();
        RecordingResult<Void> reentrantStop = new RecordingResult<>();
        fixture.events.onEnded = () -> {
            fixture.controller.close(sessionId, reentrantClose);
            fixture.controller.stopScan("scan", reentrantStop);
        };
        RecordingResult<Void> closed = fixture.close(sessionId);

        assertEquals(0, reentrantClose.settlements);
        assertEquals(0, reentrantStop.settlements);
        assertFailure(fixture.start("next"), "BUSY", null);
        fixture.finishCleanup();
        assertSuccess(closed);
        assertSuccess(reentrantClose);
        assertSuccess(reentrantStop);
        assertEquals(1, transport.closeCalls);
        assertEquals(1, fixture.events.ended.size());
        assertEquals(1, fixture.events.scans.size());
    }

    @Test
    public void stopCancelsABlockedConnectOnAnotherThread() throws Exception {
        try (ThreadedFixture fixture = new ThreadedFixture()) {
            BlockingTransport transport = new BlockingTransport(true);
            fixture.startAndDiscover(transport);
            await(transport.entered);
            RecordingResult<Void> stopping = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.stopScan("scan", stopping));
            await(stopping.completed);
            fixture.onControl(() -> {});

            assertSuccess(stopping);
            assertTrue(fixture.events.opened.isEmpty());
            assertEquals(1, fixture.events.ended.size());
            assertEquals("scan-stopped", fixture.events.ended.get(0).reason);
            assertNotSame(transport.workerThread, transport.firstCloseThread);
            assertEquals(1, fixture.reader.stopCalls);
        }
    }

    @Test
    public void closeCancelsABlockedExchangeWithAnUnknownOutcomeAndKeepsScanning() throws Exception {
        try (ThreadedFixture fixture = new ThreadedFixture()) {
            BlockingTransport transport = new BlockingTransport(false);
            fixture.startAndDiscover(transport);
            await(fixture.events.firstOpened);
            String sessionId = fixture.events.lastSessionId();
            RecordingResult<byte[]> exchange = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.transceive(sessionId, COMMAND, null, exchange));
            await(transport.entered);
            RecordingResult<Void> closed = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.close(sessionId, closed));
            await(closed.completed);
            fixture.onControl(() -> {});

            assertFailure(exchange, "CANCELLED", "unknown");
            assertSuccess(closed);
            assertNotSame(transport.workerThread, transport.firstCloseThread);
            assertEquals(0, fixture.reader.stopCalls);
            assertEquals(1, transport.transceiveCalls);
        }
    }

    @Test
    public void stopCancelsABlockedExchangeBeforeAllowingANewScan() throws Exception {
        try (ThreadedFixture fixture = new ThreadedFixture()) {
            BlockingTransport transport = new BlockingTransport(false);
            fixture.startAndDiscover(transport);
            await(fixture.events.firstOpened);
            String sessionId = fixture.events.lastSessionId();
            RecordingResult<byte[]> exchange = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.transceive(sessionId, COMMAND, null, exchange));
            await(transport.entered);
            RecordingResult<Void> stopping = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.stopScan("scan", stopping));
            await(stopping.completed);
            fixture.onControl(() -> {});

            assertFailure(exchange, "CANCELLED", "unknown");
            assertSuccess(stopping);
            assertEquals(1, fixture.reader.stopCalls);
            RecordingResult<Void> next = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.startScan("next", 1000, next));
            assertSuccess(next);
        }
    }

    @Test
    public void theConnectionWatchdogCancelsABlockedConnectButKeepsTheScan() throws Exception {
        try (ThreadedFixture fixture = new ThreadedFixture()) {
            BlockingTransport transport = new BlockingTransport(true);
            fixture.startAndDiscover(transport);
            await(transport.entered);
            fixture.onControl(() -> fixture.scheduler.latest().fire());
            RecordingResult<Void> cleanup = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.close(fixture.events.ended.get(0).sessionId, cleanup));
            await(cleanup.completed);
            fixture.onControl(() -> {});

            assertSuccess(cleanup);
            assertTrue(fixture.events.opened.isEmpty());
            assertEquals("connect-timeout", fixture.events.ended.get(0).reason);
            assertEquals("TIMEOUT", fixture.events.ended.get(0).code);
            assertEquals(0, fixture.reader.stopCalls);
        }
    }

    @Test
    public void theExchangeWatchdogCancelsIoWhenThePlatformDoesNotReturn() throws Exception {
        try (ThreadedFixture fixture = new ThreadedFixture()) {
            BlockingTransport transport = new BlockingTransport(false);
            fixture.startAndDiscover(transport);
            await(fixture.events.firstOpened);
            String sessionId = fixture.events.lastSessionId();
            RecordingResult<byte[]> exchange = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.transceive(sessionId, COMMAND, 250, exchange));
            await(transport.entered);
            fixture.onControl(() -> fixture.scheduler.latest().fire());
            RecordingResult<Void> cleanup = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.close(sessionId, cleanup));
            await(cleanup.completed);
            fixture.onControl(() -> {});

            assertFailure(exchange, "TIMEOUT", "unknown");
            assertSuccess(cleanup);
            assertEquals("transceive-timeout", fixture.events.ended.get(0).reason);
            assertEquals(1, transport.transceiveCalls);
            assertEquals(0, fixture.reader.stopCalls);
        }
    }

    @Test
    public void aLateSuccessfulConnectIsClosedBeforeStopCompletesOrANewScanStarts() throws Exception {
        try (ThreadedFixture fixture = new ThreadedFixture()) {
            LateConnectTransport transport = new LateConnectTransport();
            fixture.startAndDiscover(transport);
            SessionController.TagCallback oldDiscovery = fixture.reader.onTag;
            await(transport.entered);
            RecordingResult<Void> stopping = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.stopScan("scan", stopping));
            await(transport.firstClose);
            fixture.onControl(() -> {});
            assertEquals(0, stopping.settlements);
            assertEquals(0, fixture.reader.stopCalls);
            RecordingResult<Void> premature = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.startScan("next", 1000, premature));
            assertFailure(premature, "BUSY", null);
            transport.releaseConnect.countDown();
            await(stopping.completed);
            fixture.onControl(() -> {});

            assertSuccess(stopping);
            assertEquals(1, fixture.reader.stopCalls);
            assertEquals(2, transport.closeCalls);
            assertFalse(transport.connected);
            assertTrue(fixture.events.opened.isEmpty());
            RecordingResult<Void> next = new RecordingResult<>();
            fixture.onControl(() -> fixture.controller.startScan("next", 1000, next));
            assertSuccess(next);
            FakeTransport stale = new FakeTransport();
            oldDiscovery.accept(stale);
            fixture.onControl(() -> {});
            fixture.reader.onTag.accept(new FakeTransport());
            await(fixture.events.firstOpened);
            assertEquals(0, stale.connectCalls);
            assertEquals("next", fixture.events.opened.get(0).scanId);
        }
    }

    private static void assertSuccess(RecordingResult<?> result) {
        assertEquals(1, result.settlements);
        assertNull(result.failure);
    }

    private static void assertFailure(RecordingResult<?> result, String code, String outcome) {
        assertEquals(1, result.settlements);
        assertNotNull(result.failure);
        assertEquals(code, result.failure.code);
        assertEquals(outcome, result.failure.outcome);
    }

    private static void assertEvent(EndedEvent event, String scanId, String sessionId, String reason, String code) {
        assertEquals(scanId, event.scanId);
        assertEquals(sessionId, event.sessionId);
        assertEquals(reason, event.reason);
        assertEquals(code, event.code);
    }

    private static void await(CountDownLatch latch) throws InterruptedException {
        assertTrue("Timed out waiting for the controlled worker", latch.await(3, TimeUnit.SECONDS));
    }

    private static final class RecordingResult<T> implements SessionController.Result<T> {
        final CountDownLatch completed = new CountDownLatch(1);
        volatile int settlements;
        volatile T value;
        volatile SessionController.Failure failure;

        @Override
        public synchronized void resolve(T value) {
            this.value = value;
            settlements++;
            completed.countDown();
        }

        @Override
        public synchronized void reject(SessionController.Failure failure) {
            this.failure = failure;
            settlements++;
            completed.countDown();
        }
    }

    private static final class OpenedEvent {
        final String scanId;
        final String sessionId;
        final SessionController.TagInfo tag;

        OpenedEvent(String scanId, String sessionId, SessionController.TagInfo tag) {
            this.scanId = scanId;
            this.sessionId = sessionId;
            this.tag = tag;
        }
    }

    private static final class EndedEvent {
        final String scanId;
        final String sessionId;
        final String reason;
        final String code;

        EndedEvent(String scanId, String sessionId, String reason, String code) {
            this.scanId = scanId;
            this.sessionId = sessionId;
            this.reason = reason;
            this.code = code;
        }
    }

    private static final class Events implements SessionController.Listener {
        final List<OpenedEvent> opened = new ArrayList<>();
        final List<EndedEvent> ended = new ArrayList<>();
        final List<EndedEvent> scans = new ArrayList<>();
        final CountDownLatch firstOpened = new CountDownLatch(1);
        Runnable onEnded = () -> {};

        @Override
        public void opened(String scanId, String sessionId, SessionController.TagInfo tag) {
            opened.add(new OpenedEvent(scanId, sessionId, tag));
            firstOpened.countDown();
        }

        @Override
        public void ended(String scanId, String sessionId, String reason, String code) {
            ended.add(new EndedEvent(scanId, sessionId, reason, code));
            onEnded.run();
        }

        @Override
        public void scanEnded(String scanId, String reason, String code) {
            scans.add(new EndedEvent(scanId, null, reason, code));
        }

        String lastSessionId() {
            return opened.get(opened.size() - 1).sessionId;
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

    private static final class ScheduledAction {
        final int delayMs;
        final Runnable action;
        boolean cancelled;

        ScheduledAction(int delayMs, Runnable action) {
            this.delayMs = delayMs;
            this.action = action;
        }

        void fire() {
            if (!cancelled) {
                action.run();
            }
        }
    }

    private static final class FakeScheduler implements SessionController.Scheduler {
        final List<ScheduledAction> actions = new ArrayList<>();

        @Override
        public Runnable schedule(int delayMs, Runnable action) {
            ScheduledAction scheduled = new ScheduledAction(delayMs, action);
            actions.add(scheduled);
            return () -> scheduled.cancelled = true;
        }

        ScheduledAction latest() {
            return actions.get(actions.size() - 1);
        }
    }

    private static final class FakeReader implements SessionController.Reader {
        volatile SessionController.TagCallback onTag;
        int startCalls;
        int stopCalls;
        boolean startFailure;
        boolean stopFailure;
        Runnable onStop = () -> {};
        SessionController.Result<Void> removal;
        int removalCalls;

        @Override
        public void start(SessionController.TagCallback onTag) {
            startCalls++;
            this.onTag = onTag;
            if (startFailure) {
                throw new IllegalStateException("Unable to start reader mode");
            }
        }

        @Override
        public void waitForRemoval(SessionController.Result<Void> result) {
            removalCalls++;
            removal = result;
        }

        @Override
        public void stop() {
            stopCalls++;
            onStop.run();
            if (stopFailure) {
                throw new IllegalStateException("Unable to stop reader mode");
            }
        }
    }

    private static class FakeTransport implements SessionController.Transport {
        int connectCalls;
        int transceiveCalls;
        volatile int closeCalls;
        String connectFailure;
        String exchangeFailure;
        RuntimeException timeoutFailure;
        boolean closeFailure;
        byte[] lastRequest;
        final List<Integer> timeouts = new ArrayList<>();

        @Override
        public void connect() throws SessionController.TransportException {
            connectCalls++;
            if (connectFailure != null) {
                throw new SessionController.TransportException(connectFailure);
            }
        }

        @Override
        public SessionController.TagInfo info() {
            return new SessionController.TagInfo(new byte[] { 1, 2, 3 }, 261, false);
        }

        @Override
        public void setTimeout(int timeoutMs) {
            if (timeoutFailure != null) {
                throw timeoutFailure;
            }
            timeouts.add(timeoutMs);
        }

        @Override
        public byte[] transceive(byte[] data) throws SessionController.TransportException {
            transceiveCalls++;
            lastRequest = data.clone();
            if (exchangeFailure != null) {
                throw new SessionController.TransportException(exchangeFailure);
            }
            return RESPONSE.clone();
        }

        @Override
        public synchronized void close() throws SessionController.TransportException {
            closeCalls++;
            if (closeFailure) {
                throw new SessionController.TransportException("IO_ERROR");
            }
        }
    }

    private static final class BlockingTransport extends FakeTransport {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch released = new CountDownLatch(1);
        final boolean blockConnect;
        Thread workerThread;
        Thread firstCloseThread;

        BlockingTransport(boolean blockConnect) {
            this.blockConnect = blockConnect;
        }

        @Override
        public void connect() throws SessionController.TransportException {
            super.connect();
            if (blockConnect) {
                waitForClose();
            }
        }

        @Override
        public byte[] transceive(byte[] data) throws SessionController.TransportException {
            super.transceive(data);
            waitForClose();
            throw new AssertionError("The blocked call must fail after close");
        }

        private void waitForClose() throws SessionController.TransportException {
            workerThread = Thread.currentThread();
            entered.countDown();
            try {
                await(released);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            throw new SessionController.TransportException("IO_ERROR");
        }

        @Override
        public synchronized void close() throws SessionController.TransportException {
            if (firstCloseThread == null) {
                firstCloseThread = Thread.currentThread();
            }
            super.close();
            released.countDown();
        }
    }

    private static final class LateConnectTransport extends FakeTransport {
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch firstClose = new CountDownLatch(1);
        final CountDownLatch releaseConnect = new CountDownLatch(1);
        volatile boolean connected;

        @Override
        public void connect() throws SessionController.TransportException {
            super.connect();
            entered.countDown();
            try {
                await(releaseConnect);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new SessionController.TransportException("IO_ERROR");
            }
            connected = true;
        }

        @Override
        public synchronized void close() throws SessionController.TransportException {
            super.close();
            connected = false;
            firstClose.countDown();
        }
    }

    private static final class Fixture {
        static final int DEFAULT_TIMEOUT = 1000;
        final FakeReader reader = new FakeReader();
        final QueueExecutor control = new QueueExecutor();
        final QueueExecutor bridge = new QueueExecutor();
        final QueueExecutor io = new QueueExecutor();
        final QueueExecutor closer = new QueueExecutor();
        final FakeScheduler scheduler = new FakeScheduler();
        final Events events = new Events();
        final SessionController controller = new SessionController(reader, control, io, closer, scheduler, events);
        final PageSessionScope page = new PageSessionScope(controller, control, bridge);

        RecordingResult<Void> start(String scanId) {
            RecordingResult<Void> result = new RecordingResult<>();
            controller.startScan(scanId, DEFAULT_TIMEOUT, result);
            return result;
        }

        RecordingResult<Void> stop(String scanId) {
            RecordingResult<Void> result = new RecordingResult<>();
            controller.stopScan(scanId, result);
            return result;
        }

        RecordingResult<Void> close(String sessionId) {
            RecordingResult<Void> result = new RecordingResult<>();
            controller.close(sessionId, result);
            return result;
        }

        RecordingResult<Void> waitForRemoval(String sessionId) {
            RecordingResult<Void> result = new RecordingResult<>();
            controller.close(sessionId, true, result);
            return result;
        }

        void connect(FakeTransport transport) {
            reader.onTag.accept(transport);
            control.runAll();
            finishExchange();
        }

        String startAndConnect(FakeTransport transport) {
            assertSuccess(start("scan"));
            connect(transport);
            return events.lastSessionId();
        }

        RecordingResult<byte[]> exchange(String sessionId, Integer timeoutMs) {
            RecordingResult<byte[]> result = new RecordingResult<>();
            controller.transceive(sessionId, COMMAND, timeoutMs, result);
            return result;
        }

        void finishExchange() {
            io.runAll();
            control.runAll();
        }

        void finishCleanup() {
            closer.runAll();
            control.runAll();
        }
    }

    private static final class ThreadedFixture implements AutoCloseable {
        final FakeReader reader = new FakeReader();
        final ExecutorService control = Executors.newSingleThreadExecutor();
        final ExecutorService io = Executors.newSingleThreadExecutor();
        final ExecutorService closer = Executors.newSingleThreadExecutor();
        final FakeScheduler scheduler = new FakeScheduler();
        final Events events = new Events();
        final SessionController controller = new SessionController(reader, control, io, closer, scheduler, events);

        void onControl(Runnable action) throws Exception {
            control.submit(action).get(3, TimeUnit.SECONDS);
        }

        void startAndDiscover(FakeTransport transport) throws Exception {
            RecordingResult<Void> started = new RecordingResult<>();
            onControl(() -> controller.startScan("scan", 1000, started));
            assertSuccess(started);
            reader.onTag.accept(transport);
        }

        @Override
        public void close() throws InterruptedException {
            io.shutdownNow();
            closer.shutdownNow();
            io.awaitTermination(3, TimeUnit.SECONDS);
            closer.awaitTermination(3, TimeUnit.SECONDS);
            control.shutdownNow();
            control.awaitTermination(3, TimeUnit.SECONDS);
        }
    }
}
