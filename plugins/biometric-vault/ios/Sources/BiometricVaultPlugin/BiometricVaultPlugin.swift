import Capacitor
import Foundation
import UIKit
import WebKit

@objc(BiometricVaultPlugin)
public final class BiometricVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BiometricVaultPlugin"
    public let jsName = "BiometricVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private let worker = DispatchQueue(label: "app.monoid.biometric-vault", qos: .userInitiated)
    private var vault: VaultController!
    private var observers: [NSObjectProtocol] = []
    private var loadingObservation: NSKeyValueObservation?
    private var document = 0
    // Read and written only on Capacitor's serial bridge queue.
    private var workerDocument = 0

    public override func load() {
        vault = VaultController(
            store: KeychainVaultStore(), makeAuthentication: { VaultAuthentication() },
            control: { DispatchQueue.main.async(execute: $0) },
            worker: { [worker] in worker.async(execute: $0) })
        vault.setForeground(
            UIApplication.shared.applicationState != .background && UIApplication.shared.isProtectedDataAvailable)

        // Face ID/Touch ID may temporarily make the application inactive. Revoke on
        // actual backgrounding or lock, so the system's own prompt cannot cancel itself.
        observe(UIApplication.didEnterBackgroundNotification) { $0.vault.setForeground(false) }
        observe(UIApplication.protectedDataWillBecomeUnavailableNotification) { $0.vault.setForeground(false) }
        observe(UIApplication.didBecomeActiveNotification) {
            $0.vault.setForeground(UIApplication.shared.isProtectedDataAvailable)
        }
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            if change.newValue == true { self?.resetDocument() }
        }
    }

    private func observe(_ name: Notification.Name, action: @escaping (BiometricVaultPlugin) -> Void) {
        observers.append(
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                if let self { action(self) }
            })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        let controller = vault
        DispatchQueue.main.async { controller?.setForeground(false) }
    }

    @objc public func getAvailability(_ call: CAPPluginCall) {
        execute(call) { call.resolve(["biometrics": VaultAuthentication.availability()]) }
    }

    @objc public func authenticate(_ call: CAPPluginCall) {
        execute(call) {
            let requestId = try self.text(call, "requestId", limit: 128)
            let reason = try self.text(call, "reason", limit: 256)
            self.vault.authenticate(
                requestId: requestId, reason: reason, completion: self.completion(call, field: "accessId"))
        }
    }

    @objc public func closeAccess(_ call: CAPPluginCall) {
        execute(call) {
            self.vault.closeAccess(try self.text(call, "accessId", limit: 128), completion: self.completion(call))
        }
    }

    @objc public func get(_ call: CAPPluginCall) { access(call, writing: false) }
    @objc public func set(_ call: CAPPluginCall) { access(call, writing: true) }

    private func access(_ call: CAPPluginCall, writing: Bool) {
        execute(call) {
            let id = try self.text(call, "id", limit: 512, utf8: true)
            let accessId = try self.text(call, "accessId", limit: 128)
            let requestId = try self.text(call, "requestId", limit: 128)
            if writing {
                let value = try self.text(call, "value", limit: 65_536, utf8: true, allowEmpty: true)
                self.vault.set(
                    accessId: accessId, id: id, value: value, requestId: requestId, completion: self.completion(call))
            } else {
                self.vault.get(
                    accessId: accessId, id: id, requestId: requestId, completion: self.completion(call, field: "value"))
            }
        }
    }

    @objc public func remove(_ call: CAPPluginCall) {
        execute(call) {
            let id = try self.text(call, "id", limit: 512, utf8: true)
            let accessId: String?
            let requestId: String?
            if call.options["accessId"] != nil {
                accessId = try self.text(call, "accessId", limit: 128)
                requestId = try self.text(call, "requestId", limit: 128)
            } else {
                guard call.options["requestId"] == nil else {
                    throw VaultError(code: "INVALID_ARGUMENT", message: "requestId requires accessId.")
                }
                accessId = nil
                requestId = nil
            }
            self.vault.remove(accessId: accessId, id: id, requestId: requestId, completion: self.completion(call))
        }
    }

    @objc public func clear(_ call: CAPPluginCall) {
        execute(call) { self.vault.clear(completion: self.completion(call)) }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        execute(call) {
            self.vault.cancel(requestId: try self.text(call, "requestId", limit: 128))
            call.resolve()
        }
    }

    private func text(_ call: CAPPluginCall, _ name: String, limit: Int, utf8: Bool = false, allowEmpty: Bool = false)
        throws -> String
    {
        try VaultArguments.text(call.options[name], name: name, limit: limit, utf8: utf8, allowEmpty: allowEmpty)
    }

    private func execute(_ call: CAPPluginCall, action: @escaping () throws -> Void) {
        let source = workerDocument
        DispatchQueue.main.async { [weak self] in
            guard let self, self.document == source else { return }
            do { try action() } catch { Self.reject(call, error: error as? VaultError ?? .storage) }
        }
    }

    private func completion(_ call: CAPPluginCall, field: String? = nil) -> VaultController.Completion {
        let source = document
        return { [weak self] result in
            guard let self, self.document == source else { return }
            switch result {
            case .success(let value):
                if let field { call.resolve([field: value as Any? ?? NSNull()]) } else { call.resolve() }
            case .failure(let error): Self.reject(call, error: error)
            }
        }
    }

    private func resetDocument() {
        document += 1
        let next = document
        vault.setForeground(false)
        vault.setForeground(
            UIApplication.shared.applicationState != .background && UIApplication.shared.isProtectedDataAvailable)
        // Reloaded JavaScript cannot inherit native authorization or execute bridge
        // mutations that were queued by the previous document.
        (bridge as? CapacitorBridge)?.dispatchQueue.async { [weak self] in self?.workerDocument = next }
    }

    private static func reject(_ call: CAPPluginCall, error: VaultError) {
        var data: [String: Any] = [:]
        if let id = call.getString("id") { data["id"] = id }
        // Platform error descriptions and secret-bearing arguments never cross into diagnostics.
        call.reject(error.message, error.code, nil, data)
    }
}
