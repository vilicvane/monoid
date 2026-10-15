package app.monoid.plugins.biometricvault;

import static org.junit.Assert.*;

import org.junit.Test;

public class VaultKeyPolicyTest {
    @Test
    public void acceptsPerOperationAuthenticationFromLegacyKeymasterAndKeystore2() throws Exception {
        VaultKeyPolicy.requireHardwareBiometrics(true, true, true, -1, true, true);
        VaultKeyPolicy.requireHardwareBiometrics(true, true, true, 0, true, true);
    }

    @Test
    public void rejectsAuthenticationWindowsAndUnrecognizedNegativeDurations() {
        for (int seconds : new int[] { Integer.MIN_VALUE, -2, 1, 30, Integer.MAX_VALUE }) {
            VaultException error = assertThrows(VaultException.class,
                () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, true, seconds, true, true));
            assertEquals("HARDWARE_SECURITY_UNAVAILABLE", error.code());
        }
    }

    @Test
    public void hardwareStorageAloneDoesNotSatisfyAuthenticationPolicy() {
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(false, true, true, 0, true, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, false, true, 0, true, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, false, 0, true, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, true, 0, false, true));
        assertThrows(VaultException.class, () -> VaultKeyPolicy.requireHardwareBiometrics(true, true, true, 0, true, false));
    }
}
