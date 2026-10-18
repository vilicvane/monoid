package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import org.junit.Test;

public class VaultKeyPolicyTest {
    @Test
    public void acceptsSixtySecondHardwareBiometricAuthentication() throws Exception {
        VaultKeyPolicy.requireHardwareBiometrics(true, true, true, 60, true, true);
    }

    @Test
    public void rejectsLegacyPerOperationKeysAndOtherAuthenticationWindows() {
        for (int seconds : new int[] { Integer.MIN_VALUE, -2, -1, 0, 1, 30, 59, 61, Integer.MAX_VALUE }) {
            VaultException error = assertThrows(VaultException.class,
                () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, true, seconds, true, true));
            assertEquals("HARDWARE_SECURITY_UNAVAILABLE", error.code());
        }
    }

    @Test
    public void hardwareStorageAloneDoesNotSatisfyAuthenticationPolicy() {
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(false, true, true, 60, true, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, false, true, 60, true, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, false, 60, true, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, true, 60, false, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, true, 60, true, false));
    }
}
