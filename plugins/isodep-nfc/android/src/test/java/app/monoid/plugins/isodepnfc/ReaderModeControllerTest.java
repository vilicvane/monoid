package app.monoid.plugins.isodepnfc;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class ReaderModeControllerTest {
    @Test
    public void stopIgnoresTheLatestTagEvenWhenTransportFilteringRejectsIt() {
        FakePlatform platform = new FakePlatform();
        FakeTransport supported = platform.addTag("supported");
        ReaderModeController<String> reader = new ReaderModeController<>(platform);
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
    public void stopAfterSessionCloseIgnoresTheLatestTagDiscardedWhileBusy() {
        FakePlatform platform = new FakePlatform();
        FakeTransport connected = platform.addTag("connected");
        FakeTransport busy = platform.addTag("busy");
        ReaderModeController<String> reader = new ReaderModeController<>(platform);
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
            "transport:busy", "close:connected", "ignore:busy", "disable"), platform.calls);
    }

    @Test
    public void callbacksFromAnOldScanCannotReplaceTheCurrentTag() {
        FakePlatform platform = new FakePlatform();
        FakeTransport current = platform.addTag("current");
        platform.addTag("stale");
        ReaderModeController<String> reader = new ReaderModeController<>(platform);
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
        ReaderModeController<String> reader = new ReaderModeController<>(platform);
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
        ReaderModeController<String> reader = new ReaderModeController<>(platform);
        reader.start(transport -> fail("This tag has no ISO-DEP transport."));
        platform.onTag.accept("tag");

        assertSame(failure, assertThrows(IllegalStateException.class, reader::stop));
        reader.stop();
        platform.onTag.accept("late");

        assertEquals(Arrays.asList("enable", "transport:tag", "ignore:tag", "disable"),
            platform.calls);
    }

    private static final class FakePlatform implements ReaderModeController.Platform<String> {
        final List<String> calls = new ArrayList<>();
        final Map<String, FakeTransport> transports = new HashMap<>();
        ReaderModeController.TagCallback<String> onTag;
        RuntimeException ignoreFailure;

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

        FakeTransport(String tag, List<String> calls) {
            this.tag = tag;
            this.calls = calls;
        }

        @Override
        public void connect() {
            connectCalls++;
            calls.add("connect:" + tag);
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
