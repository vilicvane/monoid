import Foundation
import LocalAuthentication

protocol VaultAuthenticating: AnyObject {
    var context: LAContext { get }
    func authenticate(reason: String, completion: @escaping (VaultError?) -> Void)
    func invalidate()
}

final class VaultAuthentication: VaultAuthenticating {
    let context = LAContext()

    init() {
        context.localizedFallbackTitle = ""
        // A new access always asks again, including immediately after device unlock.
        context.touchIDAuthenticationAllowableReuseDuration = 0
    }

    func authenticate(reason: String, completion: @escaping (VaultError?) -> Void) {
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            completion(VaultError.authentication(error))
            return
        }
        context.localizedReason = reason
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) {
            [context] success, error in
            if success {
                // Protected operations reuse only this successfully evaluated context. Never
                // reopen UI or offer a passcode when the authorization is no longer usable.
                context.interactionNotAllowed = true
            }
            completion(success ? nil : VaultError.authentication(error))
        }
    }

    func invalidate() {
        context.invalidate()
    }

    static func availability() -> String {
        let context = LAContext()
        defer { context.invalidate() }
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            return "available"
        }
        guard let error = error as? LAError else { return "unknown" }
        switch error.code {
        case .biometryNotEnrolled: return "not-enrolled"
        case .biometryNotAvailable: return context.biometryType == .none ? "unsupported" : "unavailable"
        case .biometryLockout, .passcodeNotSet: return "unavailable"
        default: return "unknown"
        }
    }
}
