package app.monoid.plugins.biometricvault;

final class VaultException extends Exception {
    private final String code;

    VaultException(String code, String message) {
        super(message);
        this.code = code;
    }

    VaultException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    String code() {
        return code;
    }
}
