package com.capacitorjs.plugins.keyboard;

import static org.junit.Assert.*;

import java.util.ArrayDeque;
import java.util.Queue;
import org.junit.Test;

public class KeyboardShowRequestTest {
    @Test
    public void focusedEditorShowsAfterOnePostedTurnWithoutAnotherFocusEvent() {
        Fixture f = new Fixture();
        f.request();
        assertEquals(0, f.target.shows);
        assertEquals(0, f.settled);
        assertEquals(1, f.target.callbacks.size());
        f.target.changed.run();
        assertEquals(1, f.target.callbacks.size());
        f.target.drain();
        assertEquals(1, f.target.shows);
        assertEquals(1, f.settled);
        assertNull(f.target.changed);
    }

    @Test
    public void biometricWindowMustReturnFocusBeforePostingTheImeRequest() {
        Fixture f = new Fixture();
        f.target.windowFocused = false;
        f.request();
        assertTrue(f.target.callbacks.isEmpty());
        assertEquals(0, f.settled);
        f.target.windowFocused = true;
        f.target.changed.run();
        assertEquals(0, f.target.shows);
        f.target.drain();
        assertEquals(1, f.target.shows);
        assertEquals(1, f.settled);
    }

    @Test
    public void hideOrActivityStopCancelsWhileWaitingForWindowFocus() {
        Fixture f = new Fixture();
        f.target.windowFocused = false;
        f.request();
        Runnable oldFocusEvent = f.target.changed;
        f.request.cancel();
        f.request.cancel();
        f.target.windowFocused = true;
        oldFocusEvent.run();
        f.target.drain();
        assertEquals(0, f.target.shows);
        assertEquals(1, f.settled);
        assertNull(f.target.changed);
    }

    @Test
    public void hideOrDestructionCancelsAnAlreadyPostedShow() {
        Fixture f = new Fixture();
        f.request();
        Runnable oldPost = f.target.callbacks.peek();
        f.request.cancel();
        oldPost.run();
        assertTrue(f.target.callbacks.isEmpty());
        assertEquals(0, f.target.shows);
        assertEquals(1, f.settled);
        assertNull(f.target.changed);
    }

    @Test
    public void replacementSettlesTheOldCallAndIgnoresItsLateCallbacks() {
        Fixture f = new Fixture();
        f.request();
        Runnable oldPost = f.target.callbacks.peek();
        Runnable oldInvalidation = f.target.invalidated;
        Target replacement = new Target();
        int[] replacementSettled = {0};
        f.request.show(replacement, () -> replacementSettled[0]++);
        assertEquals(1, f.settled);
        assertNull(f.target.changed);
        oldPost.run();
        oldInvalidation.run();
        assertEquals(0, replacementSettled[0]);
        replacement.drain();
        assertEquals(0, f.target.shows);
        assertEquals(1, replacement.shows);
        assertEquals(1, replacementSettled[0]);
    }

    @Test
    public void losingTheCapturedEditorCancelsInsteadOfShowingForAnotherEditor() {
        Fixture f = new Fixture();
        f.request();
        f.target.current = false;
        f.target.changed.run();
        f.target.current = true;
        f.target.drain();
        assertEquals(0, f.target.shows);
        assertEquals(1, f.settled);
        assertNull(f.target.changed);
    }

    @Test
    public void detachNotificationCancelsEvenBeforeTheViewUpdatesItsAttachmentFlag() {
        Fixture f = new Fixture();
        f.request();
        assertTrue(f.target.attached);
        f.target.invalidated.run();
        f.target.drain();
        assertEquals(0, f.target.shows);
        assertEquals(1, f.settled);
        assertNull(f.target.changed);
    }

    @Test
    public void dispatchRechecksFocusAndAttachmentEvenWithoutAnEvent() {
        for (boolean detached : new boolean[] {false, true}) {
            Fixture f = new Fixture();
            f.request();
            if (detached) f.target.attached = false;
            else f.target.current = false;
            f.target.drain();
            assertEquals(0, f.target.shows);
            assertEquals(1, f.settled);
            assertNull(f.target.changed);
        }
    }

    @Test
    public void losingWindowFocusBeforeDispatchWaitsForItsNextFocusEvent() {
        Fixture f = new Fixture();
        f.request();
        f.target.windowFocused = false;
        f.target.drain();
        assertEquals(0, f.target.shows);
        assertEquals(0, f.settled);
        assertTrue(f.target.callbacks.isEmpty());
        f.target.windowFocused = true;
        f.target.changed.run();
        f.target.drain();
        assertEquals(1, f.target.shows);
        assertEquals(1, f.settled);
    }

    @Test
    public void windowFocusLossRemovesAnObsoletePostedRequest() {
        Fixture f = new Fixture();
        f.request();
        f.target.windowFocused = false;
        f.target.changed.run();
        assertTrue(f.target.callbacks.isEmpty());
        f.target.windowFocused = true;
        f.target.changed.run();
        f.target.drain();
        assertEquals(1, f.target.shows);
        assertEquals(1, f.settled);
    }

    @Test
    public void aDispatchedRequestNeverReopensTheKeyboardOnLaterFocusEvents() {
        Fixture f = new Fixture();
        f.request();
        Runnable focusEvent = f.target.changed;
        f.target.drain();
        // The user dismisses the keyboard; later native-window changes are unrelated.
        f.target.windowFocused = false;
        focusEvent.run();
        f.target.windowFocused = true;
        focusEvent.run();
        f.target.drain();
        assertEquals(1, f.target.shows);
        assertEquals(1, f.settled);
    }

    @Test
    public void missingOrInvalidTargetsSettleWithoutRegisteringOrPosting() {
        Fixture f = new Fixture();
        f.request.show(null, () -> f.settled++);
        f.target.current = false;
        f.request();
        f.target.current = true;
        f.target.attached = false;
        f.request();
        assertEquals(3, f.settled);
        assertEquals(0, f.target.shows);
        assertNull(f.target.changed);
        assertTrue(f.target.callbacks.isEmpty());
    }

    @Test
    public void failedPostingSettlesAndReleasesTheFocusListeners() {
        Fixture f = new Fixture();
        f.target.acceptPost = false;
        f.request();
        assertEquals(1, f.settled);
        assertEquals(0, f.target.shows);
        assertNull(f.target.changed);
        assertTrue(f.target.callbacks.isEmpty());
    }

    private static final class Fixture {
        final KeyboardShowRequest request = new KeyboardShowRequest();
        final Target target = new Target();
        int settled;

        void request() {
            request.show(target, () -> settled++);
        }
    }

    private static final class Target implements KeyboardShowRequest.Target {
        boolean attached = true;
        boolean current = true;
        boolean windowFocused = true;
        boolean acceptPost = true;
        int shows;
        Runnable changed;
        Runnable invalidated;
        final Queue<Runnable> callbacks = new ArrayDeque<>();

        @Override
        public boolean isCurrentFocus() {
            return current;
        }

        @Override
        public boolean isAttached() {
            return attached;
        }

        @Override
        public boolean hasWindowFocus() {
            return windowFocused;
        }

        @Override
        public Runnable watch(Runnable changed, Runnable invalidated) {
            this.changed = changed;
            this.invalidated = invalidated;
            return () -> {
                this.changed = null;
                this.invalidated = null;
            };
        }

        @Override
        public boolean post(Runnable callback) {
            if (!acceptPost) return false;
            return callbacks.add(callback);
        }

        @Override
        public void remove(Runnable callback) {
            callbacks.remove(callback);
        }

        @Override
        public void show() {
            assertTrue(current && attached && windowFocused);
            shows++;
        }

        void drain() {
            while (!callbacks.isEmpty()) callbacks.remove().run();
        }
    }
}
