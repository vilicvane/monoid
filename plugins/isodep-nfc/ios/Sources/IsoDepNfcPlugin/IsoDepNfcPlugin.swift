import Capacitor
import Foundation
import UIKit
import WebKit

@objc(IsoDepNfcPlugin)
public final class IsoDepNfcPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IsoDepNfcPlugin"
    public let jsName = "IsoDepNfc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transceive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSessionMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeSession", returnType: CAPPluginReturnPromise)
    ]

    private var sessions: NFCSessionController!
    private var observers: [NSObjectProtocol] = []
    private var lastAvailability: Bool?
    private var loadingObservation: NSKeyValueObservation?
    private var document = 0
    private var scanDocument = 0
    // Capacitor invokes plugin methods on its serial bridge queue.
    private var workerDocument = 0

    public override func load() {
        sessions = NFCSessionController(schedule: { milliseconds, callback in
            let work = DispatchWorkItem(block: callback)
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(milliseconds), execute: work)
            return { work.cancel() }
        }, emit: { [weak self] event, data in
            guard let self, self.scanDocument == self.document else { return }
            self.notifyListeners(event, data: data)
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.sessions.terminate(reason: "app-paused", code: "APP_INACTIVE")
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.refreshStatus()
        })
        // The bridge retains plugin instances when a renderer is reloaded. The
        // old document must lose both its reader and any pending APDU replies.
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            if change.newValue == true { self?.resetDocument() }
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        let sessions = sessions
        DispatchQueue.main.async {
            sessions?.terminate(reason: "destroyed", code: "APP_INACTIVE")
        }
    }

    @objc public func getStatus(_ call: CAPPluginCall) {
        dispatch { _ in
            let available = self.refreshStatus()
            call.resolve(["supported": available, "enabled": available])
        }
    }

    @objc public func openSettings(_ call: CAPPluginCall) {
        dispatch { _ in
            call.reject("iOS does not provide an NFC settings screen or NFC enable switch.", "UNSUPPORTED")
        }
    }

    @objc public func startScan(_ call: CAPPluginCall) {
        perform(call, operation: "startScan", idKey: "scanId") { options, id, document in
            let timeout = try NFCArguments.timeout(options, key: "transceiveTimeoutMs") ?? 10_000
            guard CoreNFCReader.available else {
                throw NFCFailure(code: "UNSUPPORTED", message: "NFC tag reading is not supported on this device.")
            }
            guard UIApplication.shared.applicationState == .active else {
                throw NFCFailure(code: "APP_INACTIVE", message: "NFC scanning requires the app in the foreground.")
            }
            guard let reader = CoreNFCReader(queue: .main) else {
                throw NFCFailure(code: "UNSUPPORTED", message: "The iOS NFC reader is unavailable.")
            }
            self.scanDocument = document
            self.sessions.start(id: id, timeoutMs: timeout, reader: reader) { [weak self] result in
                self?.settle(call, result: result, idKey: "scanId", id: id, operation: "startScan", document: document)
            }
        }
    }

    @objc public func stopScan(_ call: CAPPluginCall) {
        perform(call, idKey: "scanId") { _, id, document in
            self.sessions.stop(id: id) { [weak self] result in
                self?.settle(call, result: result, idKey: "scanId", id: id, document: document)
            }
        }
    }

    @objc public func transceive(_ call: CAPPluginCall) {
        perform(call, operation: "transceive", idKey: "sessionId") { options, id, document in
            let bytes = try NFCArguments.bytes(options)
            let timeout = try NFCArguments.timeout(options, key: "timeoutMs")
            self.sessions.transceive(id: id, bytes: bytes, timeoutMs: timeout) { [weak self] result in
                guard let self, self.document == document else { return }
                switch result {
                case .success(let data): call.resolve(["data": data])
                case .failure(let failure): self.reject(call, failure: failure, idKey: "sessionId", id: id, operation: "transceive")
                }
            }
        }
    }

    @objc public func setSessionMessage(_ call: CAPPluginCall) {
        perform(call, idKey: "sessionId") { options, id, _ in
            let message = try NFCArguments.message(options)
            try self.sessions.setSessionMessage(id: id, message: message)
            call.resolve()
        }
    }

    @objc public func closeSession(_ call: CAPPluginCall) {
        perform(call, idKey: "sessionId") { options, id, document in
            let waitForRemoval = try NFCArguments.waitForRemoval(options)
            let message = options["message"] == nil ? nil : try NFCArguments.message(options)
            self.sessions.close(id: id, waitForRemoval: waitForRemoval, message: message) { [weak self] result in
                self?.settle(call, result: result, idKey: "sessionId", id: id, document: document)
            }
        }
    }

    private func perform(_ call: CAPPluginCall, operation: String? = nil, idKey: String,
                         action: @escaping ([String: Any], String, Int) throws -> Void) {
        dispatch { document in
            let options = call.jsObjectRepresentation
            do {
                let id = try NFCArguments.id(options, key: idKey)
                try action(options, id, document)
            } catch var failure as NFCFailure {
                if operation == "transceive" { failure.outcome = "not-sent" }
                self.reject(call, failure: failure, idKey: idKey, id: options[idKey] as? String, operation: operation)
            } catch {
                call.reject("The NFC operation could not be prepared.", "IO_ERROR")
            }
        }
    }

    private func dispatch(_ action: @escaping (Int) -> Void) {
        let source = workerDocument
        DispatchQueue.main.async { [weak self] in
            guard let self, self.document == source else { return }
            action(source)
        }
    }

    private func resetDocument() {
        document += 1
        let next = document
        sessions.terminate(reason: "destroyed", code: "APP_INACTIVE")
        // Do not replace the controller: a new reader must still wait for the
        // old reader's invalidation callback. Reject queued old bridge calls.
        (bridge as? CapacitorBridge)?.dispatchQueue.async { [weak self] in
            self?.workerDocument = next
        }
    }

    private func settle(_ call: CAPPluginCall, result: Result<Void, NFCFailure>, idKey: String, id: String,
                        operation: String? = nil, document: Int) {
        guard self.document == document else { return }
        switch result {
        case .success: call.resolve()
        case .failure(let failure): reject(call, failure: failure, idKey: idKey, id: id, operation: operation)
        }
    }

    private func reject(_ call: CAPPluginCall, failure: NFCFailure, idKey: String, id: String?, operation: String? = nil) {
        var data: [String: Any] = [:]
        data[idKey] = id
        data["operation"] = operation
        data["outcome"] = failure.outcome
        call.reject(failure.message, failure.code, nil, data)
    }

    @discardableResult
    private func refreshStatus() -> Bool {
        let available = CoreNFCReader.available
        if let previous = lastAvailability, previous != available {
            notifyListeners("statusChanged", data: ["supported": available, "enabled": available])
        }
        lastAvailability = available
        return available
    }
}
