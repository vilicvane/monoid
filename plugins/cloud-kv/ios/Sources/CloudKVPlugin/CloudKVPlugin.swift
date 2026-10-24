import Capacitor
import Foundation

/// Requires the app entitlement
/// `com.apple.developer.ubiquity-kvstore-identifier = $(TeamIdentifierPrefix)$(CFBundleIdentifier)`.
@objc(CloudKVPlugin)
public final class CloudKVPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CloudKVPlugin"
    public let jsName = "CloudKV"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "synchronize", returnType: CAPPluginReturnPromise),
    ]

    private let keyValueStore = NSUbiquitousKeyValueStore.default
    private lazy var store = CloudKVStore(backend: keyValueStore)
    private var observer: NSObjectProtocol?

    public override func load() {
        observer = NotificationCenter.default.addObserver(
            forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: keyValueStore, queue: nil
        ) { [weak self] notification in
            self?.notifyChange(notification)
        }
        // Starts the initial download; its result arrives as an `initial-sync` change.
        keyValueStore.synchronize()
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private func notifyChange(_ notification: Notification) {
        let reason = notification.userInfo?[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int
        let keys = notification.userInfo?[NSUbiquitousKeyValueStoreChangedKeysKey] as? [String] ?? []
        // Retained so a change that arrives before the web app subscribes is not lost.
        notifyListeners(
            "change",
            data: ["reason": CloudKVStore.changeReason(reason), "keys": keys.sorted()],
            retainUntilConsumed: true)
    }

    @objc public func getInfo(_ call: CAPPluginCall) {
        call.resolve(["backend": "icloud", "liveSync": true])
    }

    @objc public func get(_ call: CAPPluginCall) {
        execute(call) {
            let value = try self.store.get(try self.string(call, "key"))
            return ["value": value.map { $0 as Any } ?? NSNull()]
        }
    }

    @objc public func set(_ call: CAPPluginCall) {
        execute(call) {
            try self.store.set(try self.string(call, "key"), value: try self.string(call, "value"))
            return [:]
        }
    }

    @objc public func remove(_ call: CAPPluginCall) {
        execute(call) {
            try self.store.remove(try self.string(call, "key"))
            return [:]
        }
    }

    @objc public func list(_ call: CAPPluginCall) {
        execute(call) {
            let prefix = call.getString("prefix") ?? ""
            let entries = self.store.list(prefix: prefix).map { ["key": $0.key, "value": $0.value] }
            return ["entries": entries]
        }
    }

    @objc public func synchronize(_ call: CAPPluginCall) {
        store.synchronize()
        call.resolve()
    }

    private func string(_ call: CAPPluginCall, _ name: String) throws -> String {
        guard let value = call.getString(name) else {
            throw CloudKVError.invalidArgument("\(name) must be a string.")
        }
        return value
    }

    private func execute(_ call: CAPPluginCall, _ body: () throws -> [String: Any]) {
        do {
            call.resolve(try body())
        } catch let error as CloudKVError {
            call.reject(error.message, error.code)
        } catch {
            call.reject(error.localizedDescription, "IO_ERROR")
        }
    }
}
