package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import android.security.keystore.UserNotAuthenticatedException;
import java.io.IOException;
import java.security.InvalidAlgorithmParameterException;
import java.security.NoSuchAlgorithmException;
import java.security.ProviderException;
import java.security.UnrecoverableKeyException;
import javax.crypto.AEADBadTagException;
import org.junit.Test;

public class AndroidVaultStoreTest {
    @Test
    public void unrecoverableKeyWithUnknownCauseRemainsAnIoError() {
        UnrecoverableKeyException exception = new UnrecoverableKeyException("Provider lookup failed");
        exception.initCause(new IOException("Transient service failure"));
        assertEquals("IO_ERROR", AndroidVaultStore.failure(exception, true).code());
        assertEquals("IO_ERROR", AndroidVaultStore.failure(new ProviderException(exception), true).code());
    }

    @Test
    public void legacyUnrecoverableKeyWithoutCauseIsReportedAsInvalidated() {
        assertEquals("ENTRY_INVALIDATED", AndroidVaultStore.failure(new UnrecoverableKeyException(), true).code());
    }

    @Test
    public void explicitUnsupportedPolicyIsDistinctFromTransientProviderFailure() {
        assertEquals("HARDWARE_SECURITY_UNAVAILABLE", AndroidVaultStore.failure(
            new ProviderException(new InvalidAlgorithmParameterException("Unsupported policy")), false
        ).code());
        assertEquals("IO_ERROR", AndroidVaultStore.failure(new ProviderException("Service unavailable"), false).code());
    }

    @Test
    public void keyLookupWrapperDoesNotHideAnExplicitUnsupportedAlgorithm() {
        UnrecoverableKeyException exception = new UnrecoverableKeyException();
        exception.initCause(new NoSuchAlgorithmException());
        assertEquals("HARDWARE_SECURITY_UNAVAILABLE", AndroidVaultStore.failure(exception, true).code());
    }

    @Test
    public void authenticationTagMismatchIsCorruptData() {
        assertEquals("DATA_CORRUPTED", AndroidVaultStore.failure(new AEADBadTagException(), true).code());
    }

    @Test
    public void expiredAuthenticationWindowIsDistinctFromPromptFailure() {
        UserNotAuthenticatedException exception = new UserNotAuthenticatedException();
        assertEquals("AUTHORIZATION_EXPIRED", AndroidVaultStore.failure(exception, true).code());
        assertEquals("AUTHORIZATION_EXPIRED", AndroidVaultStore.failure(new ProviderException(exception), false).code());
    }
}
