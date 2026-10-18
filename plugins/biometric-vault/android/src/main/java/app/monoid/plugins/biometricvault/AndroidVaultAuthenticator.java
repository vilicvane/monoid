package app.monoid.plugins.biometricvault;

import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import androidx.annotation.RequiresApi;
import androidx.appcompat.app.AppCompatActivity;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

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
        String reason,
        VaultController.AuthenticationCallback callback
    ) throws VaultException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            throw new VaultException("UNSUPPORTED", "Biometric vault access requires Android 11 or later.");
        }

        Request request = new Request(callbackExecutor, callback);
        try {
            Api30.start(activity, callbackExecutor, request, reason);
        } catch (RuntimeException exception) {
            request.abandon();
            throw new VaultException("AUTHENTICATION_FAILED", "Unable to start biometric authentication.");
        }
        return request;
    }

    private static final class Request implements VaultController.Authentication {
        final CancellationSignal cancellationSignal = new CancellationSignal();
        private final AtomicBoolean terminal = new AtomicBoolean();
        private final Executor executor;
        private final VaultController.AuthenticationCallback callback;

        Request(Executor executor, VaultController.AuthenticationCallback callback) {
            this.executor = executor;
            this.callback = callback;
        }

        void succeeded() {
            if (terminal.compareAndSet(false, true)) {
                executor.execute(callback::authenticated);
            }
        }

        void failed(VaultException error) {
            if (terminal.compareAndSet(false, true)) {
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
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private static final class Api30 {
        static void start(AppCompatActivity activity, Executor executor, Request request, String reason) {
            BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                .setTitle(reason)
                .setConfirmationRequired(true)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButton(activity.getString(android.R.string.cancel), executor, (dialog, which) -> request.cancel())
                .build();
            prompt.authenticate(
                request.cancellationSignal,
                executor,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        request.succeeded();
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence ignoredMessage) {
                        request.failed(authenticationError(errorCode));
                    }
                }
            );
        }
    }

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
