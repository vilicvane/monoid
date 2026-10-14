package app.monoid;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LaunchScreenControllerTest {

    @Test
    public void preparedPageWaitsUntilMinimumDisplayDeadline() {
        LaunchScreenController.State state = new LaunchScreenController.State(1410);
        state.pageStarted();
        assertTrue(state.pagePrepared(1));
        assertTrue(state.isWaiting());
        assertTrue(state.keepOnScreen(1409));
        assertFalse(state.keepOnScreen(1410));
        assertFalse(state.isWaiting());
    }

    @Test
    public void elapsedDeadlineStillWaitsForPreparedPage() {
        LaunchScreenController.State state = new LaunchScreenController.State(1410);
        state.pageStarted();
        assertTrue(state.keepOnScreen(1410));
        assertTrue(state.keepOnScreen(3000));
        assertTrue(state.isWaiting());
        assertTrue(state.pagePrepared(1));
        assertFalse(state.keepOnScreen(3000));
    }

    @Test
    public void navigationDuringMinimumDisplayWaitRequiresNewPreparedFrame() {
        LaunchScreenController.State state = new LaunchScreenController.State(1410);
        state.pageStarted();
        assertTrue(state.pagePrepared(1));
        assertTrue(state.keepOnScreen(1000));

        state.pageStarted();
        assertFalse(state.pagePrepared(1));
        assertTrue(state.keepOnScreen(1410));
        assertTrue(state.pagePrepared(2));
        assertFalse(state.keepOnScreen(1410));
    }

    @Test
    public void preDrawReleaseIsFinalAndLaterNavigationDoesNotReplay() {
        LaunchScreenController.State state = new LaunchScreenController.State(0);
        state.pageStarted();
        assertTrue(state.keepOnScreen(0));
        assertTrue(state.pagePrepared(1));
        assertFalse(state.keepOnScreen(0));

        state.pageStarted();
        assertFalse(state.isWaiting());
        assertFalse(state.keepOnScreen(1000));
        assertFalse(state.pagePrepared(1));
        assertFalse(state.pagePrepared(2));
        assertFalse(state.pageFailed());
    }

    @Test
    public void closeBeforeDeadlineRejectsLateFrameAndDoesNotReplay() {
        LaunchScreenController.State state = new LaunchScreenController.State(1410);
        state.pageStarted();
        assertTrue(state.pagePrepared(1));
        assertTrue(state.keepOnScreen(1000));
        state.close();

        assertFalse(state.isWaiting());
        assertFalse(state.keepOnScreen(1000));
        assertFalse(state.pagePrepared(1));
        assertFalse(state.pageFailed());
        state.pageStarted();
        assertFalse(state.keepOnScreen(3000));
        assertFalse(state.pagePrepared(2));
    }

    @Test
    public void pageFailureAllowsReleaseAfterMinimumDisplayDeadline() {
        LaunchScreenController.State state = new LaunchScreenController.State(1410);
        state.pageStarted();
        assertTrue(state.pageFailed());
        assertTrue(state.isWaiting());
        assertTrue(state.keepOnScreen(1409));
        assertFalse(state.keepOnScreen(1410));
        assertFalse(state.pageFailed());
    }

    @Test
    public void minimumDisplayScalesAnimationButKeepsCompleteHoldUnscaled() {
        assertEquals(1410, LaunchScreenController.minimumDisplayMillis(1160, 250, 1f));
        assertEquals(830, LaunchScreenController.minimumDisplayMillis(1160, 250, 0.5f));
        assertEquals(11850, LaunchScreenController.minimumDisplayMillis(1160, 250, 10f));
        assertEquals(252, LaunchScreenController.minimumDisplayMillis(3, 250, 0.5f));
    }

    @Test
    public void disabledAnimationsSkipAnimationAndCompleteHold() {
        assertEquals(0, LaunchScreenController.minimumDisplayMillis(1160, 250, 0f));
        assertEquals(0, LaunchScreenController.minimumDisplayMillis(1160, 250, -1f));
    }
}
