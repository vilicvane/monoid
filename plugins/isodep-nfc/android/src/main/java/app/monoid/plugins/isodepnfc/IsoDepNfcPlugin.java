package app.monoid.plugins.isodepnfc;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.nfc.NfcAdapter;
import android.nfc.NfcManager;
import android.nfc.Tag;
import android.nfc.tech.IsoDep;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;

@CapacitorPlugin(name = "IsoDepNfc")
public final class IsoDepNfcPlugin extends Plugin {
    private static final int DEFAULT_TRANSCEIVE_TIMEOUT_MS = 10_000;
    private static final int TAG_REMOVAL_DEBOUNCE_MS = 1_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "IsoDepNfc-io"));
    private final ExecutorService closer = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "IsoDepNfc-close"));
    private NfcAdapter adapter;
    private SessionController sessions;
    private boolean resumed;
    private boolean destroyed;
    private Boolean lastEnabled;

    private final BroadcastReceiver adapterReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            refreshStatus();
        }
    };

    @Override
    public void load() {
        NfcManager manager = (NfcManager) getContext().getSystemService(Context.NFC_SERVICE);
        adapter = manager == null ? null : manager.getDefaultAdapter();
        resumed = getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
        sessions = new SessionController(new ReaderModeController<>(new ReaderModeController.Platform<Tag>() {
            @Override
            public void enable(ReaderModeController.TagCallback<Tag> onTag) {
                // SKIP_NDEF_CHECK also bypasses Android's ignore/debounce path,
                // causing its removal callback to fire even while a tag remains.
                adapter.enableReaderMode(getActivity(), onTag::accept,
                    NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                    | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS, null);
            }

            @Override
            public SessionController.Transport transport(Tag tag) {
                IsoDep isoDep = IsoDep.get(tag);
                return isoDep == null ? null : new AndroidIsoDepTransport(isoDep);
            }

            @Override
            public void waitForRemoval(Tag tag, Runnable removed) throws SessionController.TransportException {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
                    throw new SessionController.TransportException("UNSUPPORTED");
                }
                if (!adapter.ignore(tag, TAG_REMOVAL_DEBOUNCE_MS, removed::run, main)) {
                    throw new SessionController.TransportException("IO_ERROR");
                }
            }

            @Override
            public void ignore(Tag tag) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && adapter.isEnabled()) {
                    boolean accepted = adapter.ignore(tag, TAG_REMOVAL_DEBOUNCE_MS, null, null);
                    // No tag identifier or payload: false can simply mean that
                    // the tag has already left the field.
                    Log.d("IsoDepNfc", "Tag redispatch suppression accepted: " + accepted);
                }
            }

            @Override
            public void disable() {
                adapter.disableReaderMode(getActivity());
            }
        }), main::post, io, closer, (delayMs, action) -> {
            main.postDelayed(action, delayMs);
            return () -> main.removeCallbacks(action);
        }, new SessionController.Listener() {
            @Override
            public void opened(String scanId, String sessionId, SessionController.TagInfo info) {
                JSObject tag = new JSObject();
                if (info.identifier != null && info.identifier.length > 0) {
                    tag.put("identifier", bytes(info.identifier));
                }
                tag.put("maxTransceiveLength", info.maxTransceiveLength);
                tag.put("adapterSupportsExtendedLengthApdu", info.adapterSupportsExtendedLengthApdu);
                JSObject event = new JSObject();
                event.put("scanId", scanId);
                event.put("sessionId", sessionId);
                event.put("tag", tag);
                notifyListeners("sessionOpened", event);
            }

            @Override
            public void ended(String scanId, String sessionId, String reason, String code) {
                JSObject event = endedEvent(scanId, reason, code);
                event.put("sessionId", sessionId);
                notifyListeners("sessionEnded", event);
            }

            @Override
            public void scanEnded(String scanId, String reason, String code) {
                notifyListeners("scanEnded", endedEvent(scanId, reason, code));
            }
        });
        ContextCompat.registerReceiver(getContext(), adapterReceiver,
            new IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED), ContextCompat.RECEIVER_EXPORTED);
        refreshStatus();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        main.post(() -> {
            Boolean enabled = readEnabled();
            if (enabled == null) {
                reject(call, "IO_ERROR", "Unable to read the NFC adapter state.", null, null, null);
            } else {
                call.resolve(status(enabled));
            }
        });
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        main.post(() -> {
            if (!available(call, null, null, false)) {
                return;
            }
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_NFC_SETTINGS));
                call.resolve();
            } catch (RuntimeException exception) {
                reject(call, "IO_ERROR", "Unable to open the NFC settings.", null, null, null);
            }
        });
    }

    @PluginMethod
    public void setSessionMessage(PluginCall call) {
        call.reject("Android NFC reader mode does not provide a system message sheet.", "UNSUPPORTED");
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        main.post(() -> {
            String id = requiredId(call, "scanId", "startScan");
            if (id == null) {
                return;
            }
            Integer transceiveTimeout = timeout(call, "transceiveTimeoutMs", DEFAULT_TRANSCEIVE_TIMEOUT_MS, null, "startScan");
            if (transceiveTimeout == null || !available(call, null, "startScan", true)) {
                return;
            }
            sessions.startScan(id, transceiveTimeout, scanResult(call, id));
        });
    }

    @PluginMethod
    public void transceive(PluginCall call) {
        main.post(() -> {
            String id = requiredId(call, "sessionId", "transceive");
            if (id == null) {
                return;
            }
            Integer timeoutMs = null;
            if (call.getData().has("timeoutMs")) {
                timeoutMs = timeout(call, "timeoutMs", DEFAULT_TRANSCEIVE_TIMEOUT_MS, id, "transceive");
                if (timeoutMs == null) {
                    return;
                }
            }
            Object value = call.getData().opt("data");
            if (!(value instanceof JSONArray) || ((JSONArray) value).length() == 0) {
                reject(call, "INVALID_ARGUMENT", "data must be a nonempty byte array.", id, "transceive", "not-sent");
                return;
            }
            JSONArray array = (JSONArray) value;
            byte[] data = new byte[array.length()];
            for (int index = 0; index < data.length; index++) {
                Object element = array.opt(index);
                if (!integerInRange(element, 0, 255)) {
                    reject(call, "INVALID_ARGUMENT", "data must contain integers from 0 to 255.", id, "transceive", "not-sent");
                    return;
                }
                data[index] = (byte) ((Number) element).intValue();
            }
            if (!available(call, id, "transceive", true)) {
                return;
            }
            sessions.transceive(id, data, timeoutMs, new SessionController.Result<byte[]>() {
                @Override
                public void resolve(byte[] response) {
                    JSObject result = new JSObject();
                    result.put("data", bytes(response));
                    call.resolve(result);
                }

                @Override
                public void reject(SessionController.Failure failure) {
                    rejectFailure(call, id, failure);
                }
            });
        });
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        main.post(() -> {
            String id = requiredId(call, "scanId", null);
            if (id == null) {
                return;
            }
            sessions.stopScan(id, scanResult(call, id));
        });
    }

    @PluginMethod
    public void closeSession(PluginCall call) {
        main.post(() -> {
            String id = requiredId(call, "sessionId", null);
            if (id == null) {
                return;
            }
            Object waitForRemoval = call.getData().opt("waitForRemoval");
            if (waitForRemoval != null && !(waitForRemoval instanceof Boolean)) {
                reject(call, "INVALID_ARGUMENT", "waitForRemoval must be a boolean.", id, null, null);
                return;
            }
            sessions.close(id, Boolean.TRUE.equals(waitForRemoval), new SessionController.Result<Void>() {
                @Override
                public void resolve(Void ignored) {
                    call.resolve();
                }

                @Override
                public void reject(SessionController.Failure failure) {
                    rejectFailure(call, id, failure);
                }
            });
        });
    }

    private boolean available(PluginCall call, String id, String operation, boolean requireEnabled) {
        String outcome = "transceive".equals(operation) ? "not-sent" : null;
        if (adapter == null) {
            reject(call, "UNSUPPORTED", "NFC is not available on this device.", id, operation, outcome);
        } else if (destroyed || !resumed || !getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
            reject(call, "APP_INACTIVE", "The activity must be resumed to use NFC.", id, operation, outcome);
        } else {
            if (requireEnabled) {
                Boolean enabled = readEnabled();
                if (enabled == null) {
                    reject(call, "IO_ERROR", "Unable to read the NFC adapter state.", id, operation, outcome);
                    return false;
                }
                if (!enabled) {
                    updateStatus(false);
                    reject(call, "NFC_DISABLED", "NFC is disabled.", id, operation, outcome);
                    return false;
                }
            }
            return true;
        }
        return false;
    }

    private JSObject status(boolean enabled) {
        JSObject result = new JSObject();
        result.put("supported", adapter != null);
        result.put("enabled", enabled);
        return result;
    }

    private void refreshStatus() {
        if (destroyed) {
            return;
        }
        Boolean enabled = readEnabled();
        if (enabled != null) {
            updateStatus(enabled);
        }
    }

    private Boolean readEnabled() {
        try {
            return adapter != null && adapter.isEnabled();
        } catch (RuntimeException exception) {
            sessions.terminate("io-error", "IO_ERROR");
            return null;
        }
    }

    private void updateStatus(boolean enabled) {
        if (!enabled) {
            sessions.terminate("nfc-disabled", "NFC_DISABLED");
        }
        if (lastEnabled != null && enabled != lastEnabled) {
            notifyListeners("statusChanged", status(enabled));
        }
        lastEnabled = enabled;
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        refreshStatus();
    }

    @Override
    protected void handleOnPause() {
        resumed = false;
        sessions.terminate("app-paused", "APP_INACTIVE");
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        resumed = false;
        sessions.terminate("destroyed", "APP_INACTIVE");
        getContext().unregisterReceiver(adapterReceiver);
        // Let already submitted work finish, including the independent close.
        io.shutdown();
        closer.shutdown();
    }

    private static String requiredId(PluginCall call, String key, String operation) {
        Object value = call.getData().opt(key);
        if (value instanceof String && !((String) value).trim().isEmpty()) {
            return (String) value;
        }
        reject(call, "INVALID_ARGUMENT", key + " must be a nonblank string.", null, operation,
            "transceive".equals(operation) ? "not-sent" : null);
        return null;
    }

    private static Integer timeout(PluginCall call, String key, int defaultValue, String id, String operation) {
        if (!call.getData().has(key)) {
            return defaultValue;
        }
        Object value = call.getData().opt(key);
        if (integerInRange(value, 1, Integer.MAX_VALUE)) {
            return ((Number) value).intValue();
        }
        reject(call, "INVALID_ARGUMENT", key + " must be a positive 32-bit integer.", id, operation,
            "transceive".equals(operation) ? "not-sent" : null);
        return null;
    }

    private static boolean integerInRange(Object value, int min, int max) {
        if (!(value instanceof Number)) {
            return false;
        }
        double number = ((Number) value).doubleValue();
        return number >= min && number <= max && number == Math.rint(number);
    }

    private static JSArray bytes(byte[] data) {
        JSArray result = new JSArray();
        for (byte value : data) {
            result.put(value & 0xff);
        }
        return result;
    }

    private static void rejectFailure(PluginCall call, String id, SessionController.Failure failure) {
        reject(call, failure.code, failure.message, id, failure.operation, failure.outcome);
    }

    private static SessionController.Result<Void> scanResult(PluginCall call, String scanId) {
        return new SessionController.Result<Void>() {
            @Override
            public void resolve(Void ignored) {
                call.resolve();
            }

            @Override
            public void reject(SessionController.Failure failure) {
                JSObject details = new JSObject();
                details.put("scanId", scanId);
                if (failure.operation != null) {
                    details.put("operation", failure.operation);
                }
                call.reject(failure.message, failure.code, details);
            }
        };
    }

    private static JSObject endedEvent(String scanId, String reason, String code) {
        JSObject event = new JSObject();
        event.put("scanId", scanId);
        event.put("reason", reason);
        if (code != null) {
            event.put("code", code);
        }
        return event;
    }

    private static void reject(PluginCall call, String code, String message, String id, String operation, String outcome) {
        JSObject details = new JSObject();
        if (id != null) {
            details.put("sessionId", id);
        }
        if (operation != null) {
            details.put("operation", operation);
        }
        if ("startScan".equals(operation)) {
            Object scanId = call.getData().opt("scanId");
            if (scanId instanceof String && !((String) scanId).trim().isEmpty()) {
                details.put("scanId", scanId);
            }
        }
        if (outcome != null) {
            details.put("outcome", outcome);
        }
        // Do not log requests, responses or platform exception messages.
        call.reject(message, code, details);
    }
}
