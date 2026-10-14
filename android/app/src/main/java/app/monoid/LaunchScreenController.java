package app.monoid;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Outline;
import android.graphics.drawable.Animatable2;
import android.graphics.drawable.AnimatedVectorDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.webkit.WebView;
import android.widget.ImageView;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.splashscreen.SplashScreenViewProvider;

final class LaunchScreenController {

    private final Activity activity;
    private final SplashScreen splashScreen;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final State state;
    private final boolean debuggable;
    private final long createdUptime = SystemClock.uptimeMillis();
    private SplashScreenViewProvider provider;
    private AnimatedVectorDrawable animation;

    LaunchScreenController(Activity activity, SplashScreen splashScreen) {
        this.activity = activity;
        this.splashScreen = splashScreen;
        debuggable = (activity.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        long minimumDisplay = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? minimumDisplayMillis(
                activity.getResources().getInteger(R.integer.monoid_launch_animation_duration),
                activity.getResources().getInteger(R.integer.monoid_launch_complete_hold_duration),
                animationsEnabled() ? animatorDurationScale() : 0f
            )
            : 0;
        // The system icon's start time is only exposed after transferring the splash.
        // Count from Activity creation instead, allowing a little extra time on launch.
        state = new State(createdUptime + minimumDisplay);
        trace("onCreate");
    }

    void attach() {
        trace("attach");
        splashScreen.setKeepOnScreenCondition(() -> state.keepOnScreen(SystemClock.uptimeMillis()));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Keep the system's original window until the animation and page are ready.
            // Registering an exit listener transfers it into the Activity, which can
            // expose an app frame between the two splash buffers on affected devices.
            long remaining = Math.max(0, state.minimumDisplayUntil - SystemClock.uptimeMillis());
            trace("systemSplash minimumRemainingMs=" + remaining);
            handler.postDelayed(() -> {
                trace("minimumDurationReached");
                activity.getWindow().getDecorView().invalidate();
            }, remaining);
        } else {
            splashScreen.setOnExitAnimationListener(this::onCompatExit);
        }
    }

    void onPageStarted() {
        trace("pageStarted");
        state.pageStarted();
    }

    void onPageLoaded(WebView webView) {
        trace("pageLoaded");
        if (!state.isWaiting()) {
            return;
        }

        long page = state.page;
        webView.postVisualStateCallback(page, new WebView.VisualStateCallback() {
            @Override
            public void onComplete(long requestId) {
                boolean prepared = state.pagePrepared(requestId);
                trace("visualPrepared page=" + requestId + " accepted=" + prepared);
                if (prepared) {
                    activity.getWindow().getDecorView().invalidate();
                }
            }
        });
    }

    void onPageError() {
        trace("pageError");
        // Capacitor does not distinguish main-frame errors here. Release rather than
        // leave the splash covering a failed page indefinitely.
        if (state.pageFailed()) {
            activity.getWindow().getDecorView().invalidate();
        }
    }

    private void onCompatExit(SplashScreenViewProvider nextProvider) {
        trace("compatExit closed=" + state.closed);
        if (state.closed) {
            trace("remove reason=late-exit");
            nextProvider.remove();
            return;
        }

        provider = nextProvider;

        if (!animationsEnabled()) {
            close("animations-disabled");
            return;
        }

        playCompatAnimation();
    }

    private void playCompatAnimation() {
        ImageView icon = (ImageView) provider.getIconView();
        animation = (AnimatedVectorDrawable) activity.getDrawable(R.drawable.monoid_launch_animation).mutate();

        // Replacing AndroidX's internal MaskedDrawable requires preserving its 2/3
        // circular viewport. The existing ImageView retains the platform icon size.
        icon.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                int diameter = Math.min(view.getWidth(), view.getHeight()) * 2 / 3;
                int left = (view.getWidth() - diameter) / 2;
                int top = (view.getHeight() - diameter) / 2;
                outline.setOval(left, top, left + diameter, top + diameter);
            }
        });
        icon.setClipToOutline(true);
        icon.setImageDrawable(animation);
        animation.registerAnimationCallback(new Animatable2.AnimationCallback() {
            @Override
            public void onAnimationEnd(Drawable drawable) {
                onIconAnimationEnd();
            }
        });
        trace("compatIconStart");
        animation.start();
    }

    private void onIconAnimationEnd() {
        trace("compatIconEnd");
        if (state.closed) {
            return;
        }

        if (!animationsEnabled()) {
            close("animations-disabled");
            return;
        }

        handler.postDelayed(() -> {
            if (!state.closed) {
                trace("fadeStart");
                provider.getView().animate().alpha(0f).setDuration(140).withEndAction(() -> close("fade-complete")).start();
            }
        }, activity.getResources().getInteger(R.integer.monoid_launch_complete_hold_duration));
    }

    private boolean animationsEnabled() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return ValueAnimator.areAnimatorsEnabled();
        }

        return animatorDurationScale() > 0f;
    }

    private float animatorDurationScale() {
        return Settings.Global.getFloat(activity.getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
    }

    void close(String reason) {
        trace("remove reason=" + reason + " hasProvider=" + (provider != null));
        state.close();
        handler.removeCallbacksAndMessages(null);

        if (animation != null) {
            animation.clearAnimationCallbacks();
            animation.stop();
            animation = null;
        }

        if (provider != null) {
            provider.getView().animate().withEndAction(null).cancel();
            provider.remove();
            provider = null;
        }

        activity.getWindow().getDecorView().invalidate();
    }

    private void trace(String event) {
        if (debuggable) {
            long now = SystemClock.uptimeMillis();
            Log.i("MonoidLaunch", "uptime=" + now + " elapsed=" + (now - createdUptime) + " " + event);
        }
    }

    static long minimumDisplayMillis(long animationDuration, long completeHold, float durationScale) {
        if (durationScale <= 0) {
            return 0;
        }

        return Math.round(animationDuration * (double) durationScale) + completeHold;
    }

    static final class State {
        private final long minimumDisplayUntil;
        private long page;
        private boolean ready;
        private boolean released;
        private boolean closed;

        State(long minimumDisplayUntil) {
            this.minimumDisplayUntil = minimumDisplayUntil;
        }

        boolean keepOnScreen(long now) {
            if (ready && now >= minimumDisplayUntil) {
                released = true;
            }

            return isWaiting();
        }

        boolean isWaiting() {
            return !released && !closed;
        }

        void pageStarted() {
            if (isWaiting()) {
                page++;
                ready = false;
            }
        }

        boolean pagePrepared(long page) {
            return this.page == page && markPageReady();
        }

        boolean pageFailed() {
            return markPageReady();
        }

        private boolean markPageReady() {
            if (!isWaiting()) {
                return false;
            }

            ready = true;
            return true;
        }

        void close() {
            closed = true;
        }
    }
}
