import Foundation

/// The subset of `NSUbiquitousKeyValueStore` used by the plugin, replaceable in tests.
protocol CloudKVBackend: AnyObject {
    func string(forKey aKey: String) -> String?
    func set(_ aString: String?, forKey aKey: String)
    func removeObject(forKey aKey: String)
    var dictionaryRepresentation: [String: Any] { get }
    @discardableResult func synchronize() -> Bool
}

extension NSUbiquitousKeyValueStore: CloudKVBackend {}

struct CloudKVError: Error, Equatable {
    let code: String
    let message: String

    static func invalidArgument(_ message: String) -> CloudKVError {
        CloudKVError(code: "INVALID_ARGUMENT", message: message)
    }

    static func quotaExceeded(_ message: String) -> CloudKVError {
        CloudKVError(code: "QUOTA_EXCEEDED", message: message)
    }
}

enum CloudKVLimits {
    static let maxKeys = 1024
    static let maxKeyBytes = 64
    static let maxTotalBytes = 1_000_000
}

/// Applies the same key, count and size limits as the JavaScript and Android layers.
/// Values written by other devices that are not strings are ignored.
final class CloudKVStore {
    private let backend: CloudKVBackend

    init(backend: CloudKVBackend) {
        self.backend = backend
    }

    func get(_ key: String) throws -> String? {
        try Self.validate(key: key)
        return backend.string(forKey: key)
    }

    func set(_ key: String, value: String) throws {
        try Self.validate(key: key)

        var count = 1
        var bytes = key.utf8.count + value.utf8.count
        for (entryKey, entryValue) in strings() where entryKey != key {
            count += 1
            bytes += entryKey.utf8.count + entryValue.utf8.count
        }
        guard count <= CloudKVLimits.maxKeys else {
            throw CloudKVError.quotaExceeded("At most \(CloudKVLimits.maxKeys) keys can be stored.")
        }
        guard bytes <= CloudKVLimits.maxTotalBytes else {
            throw CloudKVError.quotaExceeded(
                "Stored keys and values must total at most \(CloudKVLimits.maxTotalBytes) UTF-8 bytes.")
        }

        backend.set(value, forKey: key)
    }

    func remove(_ key: String) throws {
        try Self.validate(key: key)
        backend.removeObject(forKey: key)
    }

    func list(prefix: String) -> [(key: String, value: String)] {
        strings()
            .filter { $0.key.hasPrefix(prefix) }
            .map { (key: $0.key, value: $0.value) }
            .sorted { $0.key.utf16.lexicographicallyPrecedes($1.key.utf16) }
    }

    func synchronize() {
        backend.synchronize()
    }

    private func strings() -> [String: String] {
        backend.dictionaryRepresentation.compactMapValues { $0 as? String }
    }

    static func validate(key: String) throws {
        guard !key.isEmpty else {
            throw CloudKVError.invalidArgument("Key must be a nonempty string.")
        }
        guard key.utf8.count <= CloudKVLimits.maxKeyBytes else {
            throw CloudKVError.invalidArgument("Key must be at most \(CloudKVLimits.maxKeyBytes) UTF-8 bytes.")
        }
    }

    static func changeReason(_ code: Int?) -> String {
        guard let code else { return "unknown" }
        switch code {
        case NSUbiquitousKeyValueStoreServerChange: return "server"
        case NSUbiquitousKeyValueStoreInitialSyncChange: return "initial-sync"
        case NSUbiquitousKeyValueStoreQuotaViolationChange: return "quota-violation"
        case NSUbiquitousKeyValueStoreAccountChange: return "account-change"
        default: return "unknown"
        }
    }
}
