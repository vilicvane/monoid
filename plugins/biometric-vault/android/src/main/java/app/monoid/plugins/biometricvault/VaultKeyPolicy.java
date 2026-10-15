package app.monoid.plugins.biometricvault;

final class VaultKeyPolicy {
    private VaultKeyPolicy() {}

    static void requireHardwareBiometrics(
        boolean hardware, boolean authenticationRequired, boolean authenticationEnforcedByHardware,
        int authenticationValiditySeconds, boolean biometricOnly, boolean invalidatesOnEnrollment
    ) throws VaultException {
        // Legacy Keymaster reports an absent AUTH_TIMEOUT as -1; Keystore2 reports it as 0.
        boolean everyOperation = authenticationValiditySeconds == -1 || authenticationValiditySeconds == 0;

        if (!hardware || !authenticationRequired || !authenticationEnforcedByHardware
            || !everyOperation || !biometricOnly || !invalidatesOnEnrollment) {
            throw new VaultException("HARDWARE_SECURITY_UNAVAILABLE", "The key does not meet the vault's hardware and authentication policy.");
        }
    }
}
