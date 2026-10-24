package app.monoid.plugins.cloudkv;

final class CloudKVException extends Exception {
    final String code;

    private CloudKVException(String code, String message) {
        super(message);
        this.code = code;
    }

    static CloudKVException invalidArgument(String message) {
        return new CloudKVException("INVALID_ARGUMENT", message);
    }

    static CloudKVException quotaExceeded(String message) {
        return new CloudKVException("QUOTA_EXCEEDED", message);
    }

    static CloudKVException io(String message) {
        return new CloudKVException("IO_ERROR", message);
    }
}
