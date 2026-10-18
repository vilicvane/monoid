package app.monoid.plugins.biometricvault;

final class VaultKeyPolicy {
    static final int AUTHENTICATION_VALIDITY_SECONDS = 60;

    private VaultKeyPolicy() {}

    static void requireHardwareBiometrics(
        boolean hardware, boolean authenticationRequired, boolean authenticationEnforcedByHardware,
        int authenticationValiditySeconds, boolean biometricOnly, boolean invalidatesOnEnrollment
    ) throws VaultException {
        if (!hardware || !authenticationRequired || !authenticationEnforcedByHardware
            || authenticationValiditySeconds != AUTHENTICATION_VALIDITY_SECONDS
            || !biometricOnly || !invalidatesOnEnrollment) {
            throw new VaultException("HARDWARE_SECURITY_UNAVAILABLE", "The key does not meet the vault's hardware and authentication policy.");
        }
    }
}
