import Foundation
import LocalAuthentication
import Security

struct VaultError: Error {
    let code: String
    let message: String

    static let inactive = VaultError(code: "APP_INACTIVE", message: "The app must be in the foreground.")
    static let closed = VaultError(code: "ACCESS_CLOSED", message: "Vault access is closed or unknown.")
    static let cancelled = VaultError(code: "CANCELLED", message: "The operation was cancelled.")
    static let expired = VaultError(code: "AUTHORIZATION_EXPIRED", message: "Biometric authorization has expired.")
    static let storage = VaultError(code: "IO_ERROR", message: "The vault operation could not be completed.")

    static func authentication(_ error: Error?) -> VaultError {
        guard let error = error as? LAError else {
            return VaultError(code: "AUTHENTICATION_FAILED", message: "Biometric authentication failed.")
        }

        switch error.code {
        case .userCancel, .userFallback, .appCancel, .systemCancel:
            return .cancelled
        case .biometryNotEnrolled:
            return VaultError(code: "BIOMETRIC_NOT_ENROLLED", message: "No biometric is enrolled.")
        case .biometryNotAvailable:
            return VaultError(code: "BIOMETRIC_UNAVAILABLE", message: "Biometric authentication is unavailable.")
        case .biometryLockout:
            return VaultError(code: "BIOMETRIC_LOCKED_OUT", message: "Biometric authentication is locked out.")
        case .passcodeNotSet:
            return VaultError(code: "HARDWARE_SECURITY_UNAVAILABLE", message: "A device passcode is required.")
        case .invalidContext:
            return .closed
        case .notInteractive:
            return .expired
        default:
            return VaultError(code: "AUTHENTICATION_FAILED", message: "Biometric authentication failed.")
        }
    }

    static func keychain(_ status: OSStatus) -> VaultError {
        switch status {
        case errSecUserCanceled:
            return .cancelled
        case errSecInteractionNotAllowed:
            return .expired
        case errSecAuthFailed:
            return VaultError(code: "ENTRY_INVALIDATED", message: "The saved entry is no longer accessible.")
        case errSecDecode:
            return VaultError(code: "DATA_CORRUPTED", message: "The saved entry could not be decoded.")
        case errSecNotAvailable, errSecUnimplemented:
            return VaultError(
                code: "HARDWARE_SECURITY_UNAVAILABLE", message: "Required Keychain protection is unavailable.")
        default:
            return .storage
        }
    }
}

enum VaultArguments {
    static func text(_ argument: Any?, name: String, limit: Int, utf8: Bool = false, allowEmpty: Bool = false) throws
        -> String
    {
        guard let raw = argument as? NSString else {
            throw VaultError(code: "INVALID_ARGUMENT", message: "\(name) must be a string.")
        }

        // Validate the original UTF-16 before bridging to Swift's repairing String conversion.
        var index = 0
        while index < raw.length {
            let character = raw.character(at: index)
            if (0xD800...0xDBFF).contains(character) {
                index += 1
                guard index < raw.length, (0xDC00...0xDFFF).contains(raw.character(at: index)) else {
                    throw VaultError(code: "INVALID_ARGUMENT", message: "\(name) must contain valid Unicode text.")
                }
            } else if (0xDC00...0xDFFF).contains(character) {
                throw VaultError(code: "INVALID_ARGUMENT", message: "\(name) must contain valid Unicode text.")
            }
            index += 1
        }

        let value = raw as String
        guard (utf8 ? value.utf8.count : raw.length) <= limit else {
            throw VaultError(code: "INVALID_ARGUMENT", message: "\(name) exceeds its size limit.")
        }
        guard allowEmpty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw VaultError(code: "INVALID_ARGUMENT", message: "\(name) must be nonblank.")
        }
        return value
    }
}
