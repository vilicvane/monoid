import LocalAuthentication
import Security
import XCTest

@testable import BiometricVaultPlugin

final class KeychainVaultStoreTests: XCTestCase {
    func testMissingItemAddsWithDeviceLocalProtectionAndScopeContext() throws {
        let keychain = RecordingKeychain()
        keychain.updateStatus = errSecItemNotFound
        let context = LAContext()
        let store = KeychainVaultStore(keychain: keychain)
        try store.set(id: "pin", value: "1234", context: context)
        XCTAssertEqual(keychain.operations, ["update", "add"])
        let attributes = try XCTUnwrap(keychain.added)
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, "app.monoid.plugins.biometric-vault")
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "pin")
        XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(attributes[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertTrue(attributes[kSecUseAuthenticationContext as String] as? LAContext === context)
        XCTAssertNotNil(attributes[kSecAttrAccessControl as String])
        XCTAssertEqual(attributes[kSecValueData as String] as? Data, Data("1234".utf8))
    }

    func testReplacementUpdatesACLAndDataWithoutDeleting() throws {
        let keychain = RecordingKeychain()
        try KeychainVaultStore(keychain: keychain).set(id: "pin", value: "replacement", context: LAContext())
        XCTAssertEqual(keychain.operations, ["update"])
        XCTAssertNotNil(keychain.updated?[kSecAttrAccessControl as String])
        XCTAssertEqual(keychain.updated?[kSecValueData as String] as? Data, Data("replacement".utf8))
    }

    func testFailedReplacementNeverDeletesOrAttemptsAdd() {
        let keychain = RecordingKeychain()
        keychain.updateStatus = errSecAuthFailed
        XCTAssertThrowsError(
            try KeychainVaultStore(keychain: keychain).set(id: "pin", value: "new", context: LAContext())
        ) {
            XCTAssertEqual(($0 as? VaultError)?.code, "ENTRY_INVALIDATED")
        }
        XCTAssertEqual(keychain.operations, ["update"])
    }

    func testMissingIsDistinctFromUnreadableAndCorrupted() throws {
        let keychain = RecordingKeychain()
        let store = KeychainVaultStore(keychain: keychain)
        keychain.copyResult = (errSecItemNotFound, nil)
        XCTAssertNil(try store.get(id: "pin", context: LAContext()))
        keychain.copyResult = (errSecInteractionNotAllowed, nil)
        XCTAssertThrowsError(try store.get(id: "pin", context: LAContext())) {
            XCTAssertEqual(($0 as? VaultError)?.code, "AUTHORIZATION_EXPIRED")
        }
        keychain.copyResult = (errSecSuccess, Data([0xFF]) as CFData)
        XCTAssertThrowsError(try store.get(id: "pin", context: LAContext())) {
            XCTAssertEqual(($0 as? VaultError)?.code, "DATA_CORRUPTED")
        }
        keychain.copyResult = (errSecSuccess, Data() as CFData)
        XCTAssertEqual(try store.get(id: "pin", context: LAContext()), "")
    }

    func testClearAndRemoveAreServiceScopedAndNoninteractive() throws {
        let keychain = RecordingKeychain()
        let store = KeychainVaultStore(keychain: keychain)
        try store.remove(id: "pin")
        let remove = try XCTUnwrap(keychain.deleted)
        XCTAssertEqual(remove[kSecAttrAccount as String] as? String, "pin")
        XCTAssertEqual(keychain.deleteInteractionNotAllowed, true)
        try store.clear()
        let clear = try XCTUnwrap(keychain.deleted)
        XCTAssertNil(clear[kSecAttrAccount as String])
        XCTAssertEqual(clear[kSecAttrService as String] as? String, "app.monoid.plugins.biometric-vault")
        XCTAssertNil(clear[kSecReturnData as String])
        XCTAssertEqual(keychain.operations, ["delete", "delete"])
    }

    func testFreshAuthenticationDisablesPasscodeFallbackAndDeviceUnlockReuse() {
        let authentication = VaultAuthentication()
        XCTAssertEqual(authentication.context.localizedFallbackTitle, "")
        XCTAssertEqual(authentication.context.touchIDAuthenticationAllowableReuseDuration, 0)
        XCTAssertFalse(authentication.context.interactionNotAllowed)
    }

    func testAuthenticationFailuresRetainActionableCodes() {
        let cases: [(LAError.Code, String)] = [
            (.userCancel, "CANCELLED"), (.userFallback, "CANCELLED"),
            (.systemCancel, "CANCELLED"), (.appCancel, "CANCELLED"),
            (.biometryNotEnrolled, "BIOMETRIC_NOT_ENROLLED"),
            (.biometryNotAvailable, "BIOMETRIC_UNAVAILABLE"),
            (.biometryLockout, "BIOMETRIC_LOCKED_OUT"),
            (.passcodeNotSet, "HARDWARE_SECURITY_UNAVAILABLE"),
            (.authenticationFailed, "AUTHENTICATION_FAILED"),
            (.notInteractive, "AUTHORIZATION_EXPIRED"), (.invalidContext, "ACCESS_CLOSED"),
        ]
        for (code, expected) in cases {
            XCTAssertEqual(VaultError.authentication(LAError(code)).code, expected)
        }
    }
}

private final class RecordingKeychain: VaultKeychain {
    var operations: [String] = []
    var updateStatus = errSecSuccess
    var copyResult: (OSStatus, CFTypeRef?) = (errSecItemNotFound, nil)
    var added: [String: Any]?
    var updated: [String: Any]?
    var deleted: [String: Any]?
    var deleteInteractionNotAllowed: Bool?
    func copy(_ query: [String: Any]) -> (OSStatus, CFTypeRef?) {
        operations.append("copy")
        return copyResult
    }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        operations.append("update")
        updated = attributes
        return updateStatus
    }
    func add(_ attributes: [String: Any]) -> OSStatus {
        operations.append("add")
        added = attributes
        return errSecSuccess
    }
    func delete(_ query: [String: Any]) -> OSStatus {
        operations.append("delete")
        deleted = query
        deleteInteractionNotAllowed =
            (query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed
        return errSecSuccess
    }
}
