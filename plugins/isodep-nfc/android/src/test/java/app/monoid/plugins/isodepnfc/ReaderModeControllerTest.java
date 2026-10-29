package app.monoid.plugins.isodepnfc;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.Executor;
import org.junit.Test;

public class ReaderModeControllerTest {
    @Test
    public void removalUsesTheLatestDiscoveredTagAndWaitsForThePlatformCallback() {
        FakePlatform platform = new FakePlatform();
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        reader.start(transport -> {});
        platform.onTag.accept("original");
        platform.onTag.accept("latest");
        SuccessResult result = new SuccessResult();
        reader.waitForRemoval(result);

        assertEquals(0, result.resolutions);
        assertTrue(platform.calls.contains("wait:latest"));
        platform.removed.run();
        assertEquals(1, result.resolutions);
    }

    @Test
    public void oldRemovalCallbacksAreIgnoredAfterReaderRestart() {
        FakePlatform platform = new FakePlatform();
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        reader.start(transport -> {});
        platform.onTag.accept("old");
        SuccessResult result = new SuccessResult();
        reader.waitForRemoval(result);
        Runnable removed = platform.removed;
        reader.stop();
        reader.start(transport -> {});
        removed.run();
        assertEquals(0, result.resolutions);
    }

    @Test
    public void unsupportedOrUnavailableRemovalIsReportedInsteadOfCompleted() {
        for (String code : Arrays.asList("UNSUPPORTED", "IO_ERROR")) {
            FakePlatform platform = new FakePlatform();
            platform.removalFailure = code;
            ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
            reader.start(transport -> {});
            platform.onTag.accept("tag");
            List<SessionController.Failure> failures = new ArrayList<>();
            reader.waitForRemoval(new SessionController.Result<Void>() {
                @Override
                public void resolve(Void value) {
                    fail("Removal was not detected.");
                }

                @Override
                public void reject(SessionController.Failure failure) {
                    failures.add(failure);
                }
            });
            assertEquals(1, failures.size());
            assertEquals(code, failures.get(0).code);
            assertFalse(failures.get(0).message.isEmpty());
        }
    }

    @Test
    public void stopIgnoresTheLatestTagEvenWhenTransportFilteringRejectsIt() {
        FakePlatform platform = new FakePlatform();
        FakeTransport supported = platform.addTag("supported");
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        List<SessionController.Transport> accepted = new ArrayList<>();
        reader.start(accepted::add);

        platform.onTag.accept("supported");
        platform.onTag.accept("unsupported");
        reader.stop();

        assertEquals(Arrays.asList(supported), accepted);
        assertEquals(Arrays.asList("enable", "transport:supported", "transport:unsupported",
            "ignore:unsupported", "disable"), platform.calls);
    }

    @Test
    public void stopAfterSessionCloseLingersWithTheLatestTagDiscardedWhileBusy() {
        FakePlatform platform = new FakePlatform();
        FakeTransport connected = platform.addTag("connected");
        FakeTransport busy = platform.addTag("busy");
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        List<String> sessions = new ArrayList<>();
        SessionController controller = new SessionController(reader, Runnable::run, Runnable::run,
            Runnable::run, (delay, action) -> () -> {}, new SessionController.Listener() {
                @Override
                public void opened(String scanId, String sessionId, SessionController.TagInfo tag) {
                    sessions.add(sessionId);
                }

                @Override
                public void ended(String scanId, String sessionId, String reason, String code) {}

                @Override
                public void scanEnded(String scanId, String reason, String code) {}
            });
        SuccessResult result = new SuccessResult();
        controller.startScan("scan", 10_000, result);
        platform.onTag.accept("connected");
        platform.onTag.accept("busy");
        assertEquals(1, sessions.size());
        assertEquals(1, connected.connectCalls);
        assertEquals(0, busy.connectCalls);

        controller.close(sessions.get(0), result);
        assertEquals(2, result.resolutions);
        assertEquals(1, connected.closeCalls);
        assertFalse(platform.calls.contains("disable"));
        controller.stopScan("scan", result);

        assertEquals(3, result.resolutions);
        assertEquals(0, busy.closeCalls);
        assertEquals(Arrays.asList("enable", "transport:connected", "connect:connected",
            "transport:busy", "close:connected"), platform.calls);
        controller.terminate("app-paused", "APP_INACTIVE");
        assertEquals(Arrays.asList("enable", "transport:connected", "connect:connected",
            "transport:busy", "close:connected", "ignore:busy", "disable"), platform.calls);
    }

    @Test
    public void nextScanProbesAndOffersTheRetainedCardWithoutCyclingReaderMode() {
        Fixture fixture = new Fixture();
        FakeTransport card = fixture.platform.addTag("card");
        fixture.start("first");
        fixture.platform.onTag.accept("card");
        fixture.drain();
        assertEquals(1, fixture.opened.size());
        fixture.stop("first");
        assertFalse(fixture.platform.calls.contains("ignore:card"));
        assertFalse(fixture.platform.calls.contains("disable"));

        fixture.start("second");
        assertEquals(1, card.connectCalls);
        fixture.drain();

        assertEquals(2, fixture.opened.size());
        assertEquals("second", fixture.opened.get(1));
        assertEquals(3, card.connectCalls); // First session, probe, new session.
        assertEquals(2, card.closeCalls); // First session and probe.
        assertEquals(1, count(fixture.platform.calls, "enable"));
        assertEquals(0, count(fixture.platform.calls, "disable"));
    }

    @Test
    public void goneRetainedTagIsDroppedWithoutEventsAndTheScanKeepsWaiting() {
        Fixture fixture = new Fixture();
        FakeTransport card = fixture.platform.addTag("gone");
        fixture.start("first");
        fixture.platform.onTag.accept("gone");
        fixture.drain();
        fixture.stop("first");
        int events = fixture.events;
        card.connectFailure = "TAG_LOST";

        fixture.start("second");
        fixture.drain();
        assertEquals(events, fixture.events);
        fixture.stop("second");
        fixture.controller.terminate("app-paused", "APP_INACTIVE");
        assertFalse(fixture.platform.calls.contains("ignore:gone"));

        fixture.start("third");
        fixture.platform.addTag("fresh");
        fixture.platform.onTag.accept("fresh");
        fixture.drain();
        assertEquals(Arrays.asList("first", "third"), fixture.opened);
    }

    @Test
    public void aTagTappedDuringLingerIsRetainedForTheNextScan() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.stop("first");
        FakeTransport card = fixture.platform.addTag("during-pin");
        fixture.platform.onTag.accept("during-pin");
        fixture.drain();
        assertEquals(0, card.connectCalls);
        assertTrue(fixture.opened.isEmpty());

        fixture.start("second");
        fixture.drain();
        assertEquals(Arrays.asList("second"), fixture.opened);
        assertEquals(2, card.connectCalls);
        assertEquals(1, count(fixture.platform.calls, "enable"));
    }

    @Test
    public void stoppingBeforeTheProbeRunsPreservesTheCardForAnotherScan() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.stop("first");
        FakeTransport card = fixture.platform.addTag("card");
        fixture.platform.onTag.accept("card");
        fixture.start("cancelled");
        fixture.stop("cancelled");
        assertEquals(0, card.connectCalls);

        fixture.start("next");
        fixture.drain();
        assertEquals(Arrays.asList("next"), fixture.opened);
        assertEquals(2, card.connectCalls);
        assertEquals(1, count(fixture.platform.calls, "enable"));
    }

    @Test
    public void pauseDuringProbeStillIgnoresTheRetainedCardAfterCleanup() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.stop("first");
        FakeTransport card = fixture.platform.addTag("card");
        fixture.platform.onTag.accept("card");
        fixture.start("second");
        fixture.control.runAll(); // The probe is queued on I/O.
        fixture.controller.terminate("app-paused", "APP_INACTIVE");
        assertEquals(0, count(fixture.platform.calls, "disable"));
        fixture.drain();
        assertEquals(0, card.connectCalls);
        assertEquals(1, count(fixture.platform.calls, "ignore:card"));
        assertEquals(1, count(fixture.platform.calls, "disable"));
        assertTrue(fixture.opened.isEmpty());
    }

    @Test
    public void lingerTimeoutIgnoresAndDisablesOnceAndDoesNotExtendOnDiscovery() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.stop("first");
        Scheduled expiry = fixture.scheduler.lastLinger();
        assertEquals(300_000, expiry.delay);
        fixture.platform.onTag.accept("unsupported");
        assertSame(expiry, fixture.scheduler.lastLinger());
        expiry.action.run();
        expiry.action.run();
        fixture.controller.terminate("app-paused", "APP_INACTIVE");
        assertEquals(Arrays.asList("enable", "transport:unsupported", "ignore:unsupported", "disable"),
            fixture.platform.calls);
        fixture.start("second");
        assertEquals(2, count(fixture.platform.calls, "enable"));
    }

    @Test
    public void cancelledLingerTimeoutCannotStopANewScanOrLaterLinger() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.stop("first");
        Scheduled old = fixture.scheduler.lastLinger();
        fixture.start("second");
        assertTrue(old.cancelled);
        old.action.run();
        assertEquals(0, count(fixture.platform.calls, "disable"));
        fixture.stop("second");
        old.action.run();
        assertEquals(0, count(fixture.platform.calls, "disable"));
        fixture.scheduler.lastLinger().action.run();
        assertEquals(1, count(fixture.platform.calls, "disable"));
    }

    @Test
    public void lifecycleEndsLingerOnceWithoutEmittingAnotherScanEvent() {
        for (String reason : Arrays.asList("app-paused", "nfc-disabled", "page-reloaded", "destroyed")) {
            Fixture fixture = new Fixture();
            fixture.start("first");
            fixture.platform.addTag("card");
            fixture.platform.onTag.accept("card");
            fixture.drain();
            fixture.stop("first");
            int events = fixture.events;
            PageSessionScope page = new PageSessionScope(fixture.controller, fixture.control, Runnable::run);
            for (int repeat = 0; repeat < 2; repeat++) {
                if (reason.equals("page-reloaded")) {
                    page.pageStarted();
                } else if (reason.equals("destroyed")) {
                    page.destroy();
                } else {
                    fixture.controller.terminate(reason, reason.equals("nfc-disabled") ? "NFC_DISABLED" : "APP_INACTIVE");
                }
            }
            fixture.scheduler.lastLinger().action.run();
            assertEquals(reason, 1, count(fixture.platform.calls, "ignore:card"));
            assertEquals(reason, 1, count(fixture.platform.calls, "disable"));
            assertEquals(reason, events, fixture.events);
            if (!reason.equals("destroyed")) {
                fixture.start("next");
                assertEquals(reason, 2, count(fixture.platform.calls, "enable"));
            }
        }
    }

    @Test
    public void removalCallbackClearsRetainedTagButCannotClearANewerDiscovery() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.platform.onTag.accept("old");
        SuccessResult removed = new SuccessResult();
        fixture.reader.waitForRemoval(removed);
        fixture.platform.removed.run();
        assertEquals(1, removed.resolutions);
        fixture.stop("first");
        fixture.controller.terminate("app-paused", "APP_INACTIVE");
        assertFalse(fixture.platform.calls.contains("ignore:old"));

        fixture.start("second");
        fixture.platform.onTag.accept("old");
        fixture.reader.waitForRemoval(removed);
        fixture.platform.onTag.accept("new");
        fixture.platform.removed.run();
        fixture.stop("second");
        fixture.controller.terminate("app-paused", "APP_INACTIVE");
        assertTrue(fixture.platform.calls.contains("ignore:new"));
    }

    @Test
    public void oldRemovalCallbackCannotResolveAfterLingerAndRestart() {
        Fixture fixture = new Fixture();
        fixture.start("first");
        fixture.platform.onTag.accept("old");
        SuccessResult removed = new SuccessResult();
        fixture.reader.waitForRemoval(removed);
        Runnable old = fixture.platform.removed;
        fixture.stop("first");
        fixture.start("second");
        fixture.platform.onTag.accept("new");
        old.run();
        assertEquals(0, removed.resolutions);
        fixture.stop("second");
        fixture.controller.terminate("app-paused", "APP_INACTIVE");
        assertTrue(fixture.platform.calls.contains("ignore:new"));
    }

    @Test
    public void callbacksFromAnOldScanCannotReplaceTheCurrentTag() {
        FakePlatform platform = new FakePlatform();
        FakeTransport current = platform.addTag("current");
        platform.addTag("stale");
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        List<SessionController.Transport> accepted = new ArrayList<>();
        reader.start(accepted::add);
        ReaderModeController.TagCallback<String> oldCallback = platform.onTag;
        reader.stop();
        oldCallback.accept("stale");

        reader.start(accepted::add);
        platform.onTag.accept("current");
        oldCallback.accept("stale");
        reader.stop();

        assertEquals(Arrays.asList(current), accepted);
        assertEquals(Arrays.asList("enable", "disable", "enable", "transport:current",
            "ignore:current", "disable"), platform.calls);
    }

    @Test
    public void stoppingWithoutATagDoesNotIgnoreOrReuseAPreviousScansTag() {
        FakePlatform platform = new FakePlatform();
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        reader.stop();
        reader.start(transport -> fail("This tag has no ISO-DEP transport."));
        platform.onTag.accept("previous");
        reader.stop();
        reader.start(transport -> fail("No tag was discovered in this scan."));
        reader.stop();
        reader.stop();

        assertEquals(Arrays.asList("enable", "transport:previous", "ignore:previous", "disable",
            "enable", "disable"), platform.calls);
    }

    @Test
    public void ignoreFailureStillDisablesAndRepeatedStopDoesNothing() {
        FakePlatform platform = new FakePlatform();
        RuntimeException failure = new IllegalStateException("NFC service unavailable");
        platform.ignoreFailure = failure;
        ReaderModeController<String> reader = new ReaderModeController<>(platform, (delay, action) -> () -> {});
        reader.start(transport -> fail("This tag has no ISO-DEP transport."));
        platform.onTag.accept("tag");

        assertSame(failure, assertThrows(IllegalStateException.class, reader::stop));
        reader.stop();
        platform.onTag.accept("late");

        assertEquals(Arrays.asList("enable", "transport:tag", "ignore:tag", "disable"),
            platform.calls);
    }

    private static int count(List<String> calls, String expected) {
        return (int) calls.stream().filter(expected::equals).count();
    }

    private static final class QueueExecutor implements Executor {
        final Queue<Runnable> actions = new ArrayDeque<>();

        @Override
        public void execute(Runnable action) {
            actions.add(action);
        }

        void runAll() {
            while (!actions.isEmpty()) {
                actions.remove().run();
            }
        }
    }

    private static final class Scheduled {
        final int delay;
        final Runnable action;
        boolean cancelled;

        Scheduled(int delay, Runnable action) {
            this.delay = delay;
            this.action = action;
        }
    }

    private static final class FakeScheduler implements SessionController.Scheduler {
        final List<Scheduled> actions = new ArrayList<>();

        @Override
        public Runnable schedule(int delay, Runnable action) {
            Scheduled scheduled = new Scheduled(delay, action);
            actions.add(scheduled);
            return () -> scheduled.cancelled = true;
        }

        Scheduled lastLinger() {
            Scheduled result = null;
            for (Scheduled action : actions) {
                if (action.delay == ReaderModeController.LINGER_TIMEOUT_MS) {
                    result = action;
                }
            }
            assertNotNull(result);
            return result;
        }
    }

    private static final class Fixture implements SessionController.Listener {
        final FakePlatform platform = new FakePlatform();
        final FakeScheduler scheduler = new FakeScheduler();
        final QueueExecutor control = new QueueExecutor();
        final QueueExecutor io = new QueueExecutor();
        final QueueExecutor closer = new QueueExecutor();
        final ReaderModeController<String> reader = new ReaderModeController<>(platform, scheduler);
        final SessionController controller = new SessionController(reader, control, io, closer, scheduler, this);
        final List<String> opened = new ArrayList<>();
        int events;

        void start(String scanId) {
            SuccessResult result = new SuccessResult();
            controller.startScan(scanId, 10_000, result);
            assertEquals(1, result.resolutions);
        }

        void stop(String scanId) {
            SuccessResult result = new SuccessResult();
            controller.stopScan(scanId, result);
            drain();
            assertEquals(1, result.resolutions);
        }

        void drain() {
            int turns = 0;
            while (!control.actions.isEmpty() || !io.actions.isEmpty() || !closer.actions.isEmpty()) {
                assertTrue("Work must quiesce", turns++ < 100);
                control.runAll();
                io.runAll();
                closer.runAll();
            }
        }

        @Override
        public void opened(String scanId, String sessionId, SessionController.TagInfo tag) {
            opened.add(scanId);
            events++;
        }

        @Override
        public void ended(String scanId, String sessionId, String reason, String code) {
            events++;
        }

        @Override
        public void scanEnded(String scanId, String reason, String code) {
            events++;
        }
    }

    private static final class FakePlatform implements ReaderModeController.Platform<String> {
        final List<String> calls = new ArrayList<>();
        final Map<String, FakeTransport> transports = new HashMap<>();
        ReaderModeController.TagCallback<String> onTag;
        RuntimeException ignoreFailure;
        String removalFailure;
        Runnable removed;

        FakeTransport addTag(String tag) {
            FakeTransport transport = new FakeTransport(tag, calls);
            transports.put(tag, transport);
            return transport;
        }

        @Override
        public void enable(ReaderModeController.TagCallback<String> onTag) {
            calls.add("enable");
            this.onTag = onTag;
        }

        @Override
        public SessionController.Transport transport(String tag) {
            calls.add("transport:" + tag);
            return transports.get(tag);
        }

        @Override
        public void waitForRemoval(String tag, Runnable removed) throws SessionController.TransportException {
            calls.add("wait:" + tag);
            if (removalFailure != null) {
                throw new SessionController.TransportException(removalFailure);
            }
            this.removed = removed;
        }

        @Override
        public void ignore(String tag) {
            calls.add("ignore:" + tag);
            if (ignoreFailure != null) {
                throw ignoreFailure;
            }
        }

        @Override
        public void disable() {
            calls.add("disable");
        }
    }

    private static final class FakeTransport implements SessionController.Transport {
        final String tag;
        final List<String> calls;
        int connectCalls;
        int closeCalls;
        String connectFailure;

        FakeTransport(String tag, List<String> calls) {
            this.tag = tag;
            this.calls = calls;
        }

        @Override
        public void connect() throws SessionController.TransportException {
            connectCalls++;
            calls.add("connect:" + tag);
            if (connectFailure != null) {
                throw new SessionController.TransportException(connectFailure);
            }
        }

        @Override
        public SessionController.TagInfo info() {
            return new SessionController.TagInfo(new byte[] { 1 }, 261, false);
        }

        @Override
        public void setTimeout(int timeoutMs) {}

        @Override
        public byte[] transceive(byte[] data) {
            throw new AssertionError("No exchange is expected in reader lifecycle tests.");
        }

        @Override
        public void close() {
            closeCalls++;
            calls.add("close:" + tag);
        }
    }

    private static final class SuccessResult implements SessionController.Result<Void> {
        int resolutions;

        @Override
        public void resolve(Void value) {
            resolutions++;
        }

        @Override
        public void reject(SessionController.Failure failure) {
            fail(failure.code + ": " + failure.message);
        }
    }
}
