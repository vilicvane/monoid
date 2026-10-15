package app.monoid.plugins.biometricvault;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.content.res.Configuration;
import android.hardware.biometrics.BiometricPrompt;
import android.hardware.fingerprint.FingerprintManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.RequiresApi;
import androidx.appcompat.app.AppCompatActivity;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.Cipher;

/** Prompt creation and cancellation run on the main thread. Each request owns its platform callbacks. */
final class AndroidVaultAuthenticator implements VaultController.Authenticator {
    private final AppCompatActivity activity;
    private final Executor callbackExecutor;

    AndroidVaultAuthenticator(AppCompatActivity activity, Executor callbackExecutor) {
        this.activity = activity;
        this.callbackExecutor = callbackExecutor;
    }

    @Override
    public VaultController.Authentication authenticate(
        Cipher cipher,
        String reason,
        VaultController.AuthenticationCallback callback
    ) throws VaultException {
        Request request = new Request(callbackExecutor, callback);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                Api28.start(activity, callbackExecutor, request, cipher, reason);
            } else {
                startFingerprint(request, cipher, reason);
            }
        } catch (VaultException exception) {
            request.abandon();
            throw exception;
        } catch (RuntimeException exception) {
            request.abandon();
            throw new VaultException("AUTHENTICATION_FAILED", "Unable to start biometric authentication.");
        }
        return request;
    }

    @SuppressWarnings("deprecation")
    private void startFingerprint(Request request, Cipher cipher, String reason) throws VaultException {
        // Older FingerprintManager instances keep mutable callback/crypto fields. A fresh context
        // gives this request a separate cached manager, so a late binder event cannot target a retry.
        Context requestContext = activity.createConfigurationContext(new Configuration(activity.getResources().getConfiguration()));
        FingerprintManager manager = (FingerprintManager) requestContext.getSystemService(Context.FINGERPRINT_SERVICE);
        if (manager == null) {
            throw new VaultException("UNSUPPORTED", "Fingerprint authentication is not supported.");
        }

        request.dialog = new AlertDialog.Builder(activity)
            .setTitle(reason)
            .setNegativeButton(android.R.string.cancel, (dialog, which) -> request.cancel())
            .setOnCancelListener(dialog -> request.cancel())
            .create();
        request.dialog.setCanceledOnTouchOutside(false);
        request.dialog.show();

        manager.authenticate(
            new FingerprintManager.CryptoObject(cipher),
            request.cancellationSignal,
            0,
            new FingerprintManager.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(FingerprintManager.AuthenticationResult result) {
                    FingerprintManager.CryptoObject authorized = result.getCryptoObject();
                    request.succeeded(authorized == null ? null : authorized.getCipher());
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence ignoredMessage) {
                    request.failed(authenticationError(errorCode));
                }
            },
            new Handler(Looper.getMainLooper())
        );
    }

    private static final class Request implements VaultController.Authentication {
        final CancellationSignal cancellationSignal = new CancellationSignal();
        private final AtomicBoolean terminal = new AtomicBoolean();
        private final Executor executor;
        private final VaultController.AuthenticationCallback callback;
        AlertDialog dialog;

        Request(Executor executor, VaultController.AuthenticationCallback callback) {
            this.executor = executor;
            this.callback = callback;
        }

        void succeeded(Cipher cipher) {
            if (terminal.compareAndSet(false, true)) {
                dismissDialog();
                executor.execute(() -> callback.authenticated(cipher));
            }
        }

        void failed(VaultException error) {
            if (terminal.compareAndSet(false, true)) {
                dismissDialog();
                executor.execute(() -> callback.failed(error));
            }
        }

        @Override
        public void cancel() {
            if (terminal.compareAndSet(false, true)) {
                cancelPlatform();
                executor.execute(() -> callback.failed(new VaultException("CANCELLED", "Biometric authentication was cancelled.")));
            }
        }

        void abandon() {
            if (terminal.compareAndSet(false, true)) {
                cancelPlatform();
            }
        }

        private void cancelPlatform() {
            try {
                cancellationSignal.cancel();
            } catch (RuntimeException ignored) {
                // Cancellation must settle locally even when the platform cannot deliver its callback.
            } finally {
                dismissDialog();
            }
        }

        private void dismissDialog() {
            AlertDialog currentDialog = dialog;
            dialog = null;
            if (currentDialog != null) {
                currentDialog.setOnCancelListener(null);
                try {
                    currentDialog.dismiss();
                } catch (RuntimeException ignored) {
                    // The Activity may already have removed this window during destruction.
                }
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private static final class Api28 {
        static void start(AppCompatActivity activity, Executor executor, Request request, Cipher cipher, String reason) {
            BiometricPrompt.Builder builder = new BiometricPrompt.Builder(activity)
                .setTitle(reason)
                .setNegativeButton(activity.getString(android.R.string.cancel), executor, (dialog, which) -> request.cancel());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                builder.setConfirmationRequired(true);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG);
            }
            builder.build().authenticate(
                new BiometricPrompt.CryptoObject(cipher),
                request.cancellationSignal,
                executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        BiometricPrompt.CryptoObject authorized = result.getCryptoObject();
                        request.succeeded(authorized == null ? null : authorized.getCipher());
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence ignoredMessage) {
                        request.failed(authenticationError(errorCode));
                    }
                }
            );
        }
    }

    @SuppressLint("InlinedApi") // Platform biometric and fingerprint error codes share these integer values.
    private static VaultException authenticationError(int errorCode) {
        switch (errorCode) {
            case BiometricPrompt.BIOMETRIC_ERROR_CANCELED:
            case BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED:
                return new VaultException("CANCELLED", "Biometric authentication was cancelled.");
            case BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT:
            case BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT:
                return new VaultException("BIOMETRIC_LOCKED_OUT", "Biometric authentication is locked out.");
            case BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS:
            case BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL:
                return new VaultException("BIOMETRIC_NOT_ENROLLED", "Strong biometric authentication is not configured.");
            case BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT:
                return new VaultException("UNSUPPORTED", "Biometric authentication is not supported.");
            case BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE:
            case BiometricPrompt.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                return new VaultException("BIOMETRIC_UNAVAILABLE", "Biometric authentication is currently unavailable.");
            default:
                return new VaultException("AUTHENTICATION_FAILED", "Biometric authentication could not be completed.");
        }
    }
}
