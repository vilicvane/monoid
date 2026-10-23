package com.capacitorjs.plugins.keyboard;

/** One explicit IME request, confined to the UI thread and its original focused view. */
final class KeyboardShowRequest {
    interface Target {
        boolean isCurrentFocus();
        boolean isAttached();
        boolean hasWindowFocus();
        Runnable watch(Runnable changed, Runnable invalidated);
        boolean post(Runnable callback);
        void remove(Runnable callback);
        void show();
    }

    private Request pending;

    void show(Target target, Runnable settled) {
        cancel();
        if (target == null || !target.isAttached() || !target.isCurrentFocus()) {
            settled.run();
            return;
        }
        Request request = new Request(target, settled);
        pending = request;
        request.unwatch = target.watch(request::update, request::finish);
        request.update();
    }

    void cancel() {
        if (pending != null) pending.finish();
    }

    private final class Request {
        final Target target;
        final Runnable settled;
        Runnable unwatch;
        Runnable posted;

        Request(Target target, Runnable settled) {
            this.target = target;
            this.settled = settled;
        }

        void update() {
            if (pending != this) return;
            if (!target.isAttached() || !target.isCurrentFocus()) {
                finish();
            } else if (!target.hasWindowFocus()) {
                removePost();
            } else if (posted == null) {
                posted = this::dispatch;
                // Let the window's input connection catch up with its focus event.
                if (!target.post(posted)) finish();
            }
        }

        void dispatch() {
            if (pending != this) return;
            posted = null;
            if (!target.isAttached() || !target.isCurrentFocus()) {
                finish();
                return;
            }
            if (!target.hasWindowFocus()) return;
            release();
            try {
                target.show();
            } finally {
                settled.run();
            }
        }

        void finish() {
            if (pending != this) return;
            release();
            settled.run();
        }

        void release() {
            pending = null;
            removePost();
            if (unwatch != null) {
                unwatch.run();
                unwatch = null;
            }
        }

        void removePost() {
            if (posted != null) {
                target.remove(posted);
                posted = null;
            }
        }
    }
}
