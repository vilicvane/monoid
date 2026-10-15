package app.monoid.plugins.biometricvault;

import android.os.Handler;
import android.os.Looper;
import androidx.biometric.BiometricManager;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "BiometricVault")
public final class BiometricVaultPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor(action -> new Thread(action, "BiometricVault-io"));
    private VaultController vault;

    @Override
    public void load() {
        // Keystore and filesystem initialization occur only on the worker, never during an availability check.
        VaultController.Store store = new VaultController.Store() {
            private AndroidVaultStore delegate;

            private AndroidVaultStore store() throws VaultException {
                if (delegate == null) {
                    delegate = new AndroidVaultStore(getContext());
                }
                return delegate;
            }

            @Override
            public VaultController.Prepared prepareSet(String id, String value) throws VaultException {
                ensureBiometricsAvailable();
                return store().prepareSet(id, value);
            }

            @Override
            public VaultController.Prepared prepareGet(String id) throws VaultException {
                return store().prepareGet(id);
            }

            @Override
            public void remove(String id) throws VaultException {
                store().remove(id);
            }

            @Override
            public void clear() throws VaultException {
                store().clear();
            }
        };
        AndroidVaultAuthenticator authenticator = new AndroidVaultAuthenticator(getActivity(), main::post);
        vault = new VaultController(store, (cipher, reason, callback) -> {
            ensureBiometricsAvailable();
            return authenticator.authenticate(cipher, reason, callback);
        }, main::post, worker);
        vault.setForeground(getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED));
    }

    @PluginMethod
    public void getAvailability(PluginCall call) {
        main.post(() -> {
            int status = biometricStatus();
            String availability;
            switch (status) {
                case BiometricManager.BIOMETRIC_SUCCESS:
                    availability = "available";
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    availability = "not-enrolled";
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                case BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED:
                    availability = "unsupported";
                    break;
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                    availability = "unavailable";
                    break;
                default:
                    availability = "unknown";
            }
            JSObject result = new JSObject();
            result.put("biometrics", availability);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void set(PluginCall call) {
        access(call, true);
    }

    @PluginMethod
    public void get(PluginCall call) {
        access(call, false);
    }

    private void access(PluginCall call, boolean writing) {
        main.post(() -> {
            String id = null;
            String requestId = null;
            try {
                id = text(call, "id", 512, true, false);
                requestId = text(call, "requestId", 128, false, false);
                String reason = text(call, "reason", 256, false, false);
                VaultController.Result result = result(call, id, requestId, !writing);
                if (writing) {
                    String value = text(call, "value", 65_536, true, true);
                    vault.set(id, value, requestId, reason, result);
                } else {
                    vault.get(id, requestId, reason, result);
                }
            } catch (VaultException exception) {
                reject(call, exception, id, requestId);
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        main.post(() -> {
            try {
                String id = text(call, "id", 512, true, false);
                vault.remove(id, result(call, id, null, false));
            } catch (VaultException exception) {
                reject(call, exception, null, null);
            }
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        main.post(() -> vault.clear(result(call, null, null, false)));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> {
            try {
                String requestId = text(call, "requestId", 128, false, false);
                vault.cancel(requestId);
                call.resolve();
            } catch (VaultException exception) {
                reject(call, exception, null, null);
            }
        });
    }

    private int biometricStatus() {
        try {
            return BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        } catch (RuntimeException ignored) {
            return BiometricManager.BIOMETRIC_STATUS_UNKNOWN;
        }
    }

    private void ensureBiometricsAvailable() throws VaultException {
        int status = biometricStatus();
        switch (status) {
            case BiometricManager.BIOMETRIC_SUCCESS:
            case BiometricManager.BIOMETRIC_STATUS_UNKNOWN:
                return;
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                throw new VaultException("BIOMETRIC_NOT_ENROLLED", "No strong biometric is enrolled.");
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
            case BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED:
                throw new VaultException("UNSUPPORTED", "Strong biometric authentication is not supported.");
            default:
                throw new VaultException("BIOMETRIC_UNAVAILABLE", "Strong biometric authentication is currently unavailable.");
        }
    }

    private static VaultController.Result result(PluginCall call, String id, String requestId, boolean reading) {
        return new VaultController.Result() {
            @Override
            public void resolve(String value) {
                if (reading) {
                    JSObject result = new JSObject();
                    result.put("value", value == null ? JSONObject.NULL : value);
                    call.resolve(result);
                } else {
                    call.resolve();
                }
            }

            @Override
            public void reject(VaultException error) {
                BiometricVaultPlugin.reject(call, error, id, requestId);
            }
        };
    }

    private static void reject(PluginCall call, VaultException error, String id, String requestId) {
        JSObject data = new JSObject();
        if (id != null) {
            data.put("id", id);
        }
        if (requestId != null) {
            data.put("requestId", requestId);
        }
        // Do not pass native causes, values, or platform error messages into bridge logs.
        call.reject(error.getMessage(), error.code(), data);
    }

    private static String text(PluginCall call, String name, int limit, boolean utf8Limit, boolean allowEmpty)
        throws VaultException {
        Object argument = call.getData().opt(name);
        if (!(argument instanceof String)) {
            throw new VaultException("INVALID_ARGUMENT", name + " must be a string.");
        }
        String value = (String) argument;
        if (value.length() > limit) {
            throw new VaultException("INVALID_ARGUMENT", name + " exceeds its size limit.");
        }

        // Count UTF-8 bytes without allocating a second plaintext buffer. Reject lossy UTF-16 conversion.
        int bytes = 0;
        boolean nonblank = false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            nonblank |= !Character.isWhitespace(character) && !Character.isSpaceChar(character);
            if (Character.isHighSurrogate(character)) {
                if (++index >= value.length() || !Character.isLowSurrogate(value.charAt(index))) {
                    throw new VaultException("INVALID_ARGUMENT", name + " must contain valid Unicode text.");
                }
                bytes += 4;
            } else if (Character.isLowSurrogate(character)) {
                throw new VaultException("INVALID_ARGUMENT", name + " must contain valid Unicode text.");
            } else {
                bytes += character < 0x80 ? 1 : character < 0x800 ? 2 : 3;
            }
        }
        if (utf8Limit && bytes > limit) {
            throw new VaultException("INVALID_ARGUMENT", name + " exceeds its UTF-8 size limit.");
        }
        if (!allowEmpty && !nonblank) {
            throw new VaultException("INVALID_ARGUMENT", name + " must be nonblank.");
        }
        return value;
    }

    @Override
    protected void handleOnResume() {
        main.post(() -> vault.setForeground(true));
    }

    @Override
    protected void handleOnPause() {
        main.post(() -> vault.setForeground(false));
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> vault.destroy(worker::shutdown));
    }
}
