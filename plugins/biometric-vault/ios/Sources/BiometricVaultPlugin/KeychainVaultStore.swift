import Foundation
import LocalAuthentication
import Security

protocol VaultStoring {
    func get(id: String, context: LAContext) throws -> String?
    func set(id: String, value: String, context: LAContext) throws
    func remove(id: String) throws
    func clear() throws
}

protocol VaultKeychain {
    func copy(_ query: [String: Any]) -> (OSStatus, CFTypeRef?)
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func add(_ attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

struct SystemVaultKeychain: VaultKeychain {
    func copy(_ query: [String: Any]) -> (OSStatus, CFTypeRef?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

final class KeychainVaultStore: VaultStoring {
    private let service: String
    private let keychain: VaultKeychain

    init(service: String = "app.monoid.plugins.biometric-vault", keychain: VaultKeychain = SystemVaultKeychain()) {
        self.service = service
        self.keychain = keychain
    }

    private func query(id: String? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let id { query[kSecAttrAccount as String] = id }
        return query
    }

    func get(id: String, context: LAContext) throws -> String? {
        var query = query(id: id)
        query[kSecUseAuthenticationContext as String] = context
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, result) = keychain.copy(query)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw VaultError.keychain(errSecDecode)
        }
        return value
    }

    func set(id: String, value: String, context: LAContext) throws {
        guard
            let accessControl = SecAccessControlCreateWithFlags(
                nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil
            )
        else {
            throw VaultError.keychain(errSecNotAvailable)
        }
        var query = query(id: id)
        query[kSecUseAuthenticationContext as String] = context
        let attributes: [String: Any] = [
            kSecAttrAccessControl as String: accessControl,
            kSecValueData as String: Data(value.utf8),
        ]

        // Keychain performs the replacement atomically. Never delete a previous item to
        // recover from a failed update: a failed save must preserve its previous value.
        var status = keychain.update(query, attributes: attributes)
        if status == errSecItemNotFound {
            query.merge(attributes) { _, new in new }
            status = keychain.add(query)
        }
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
    }

    func remove(id: String) throws {
        try delete(query(id: id))
    }

    func clear() throws {
        try delete(query())
    }

    private func delete(_ query: [String: Any]) throws {
        let context = LAContext()
        context.interactionNotAllowed = true
        defer { context.invalidate() }
        var query = query
        query[kSecUseAuthenticationContext as String] = context
        let status = keychain.delete(query)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw VaultError.keychain(status)
        }
    }
}
