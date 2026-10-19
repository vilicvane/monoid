import AVFoundation
import Capacitor
import Foundation
import UIKit
import WebKit

@objc(QrScannerPlugin)
public final class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrScannerPlugin"
    public let jsName = "QrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePreviewBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "animatePreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopScan", returnType: CAPPluginReturnPromise)
    ]

    private var scans: QrScanController!
    private var notifications: [NSObjectProtocol] = []
    private var loadingObservation: NSKeyValueObservation?
    private lazy var permissions = QrCameraPermissions(
        authorizationStatus: { AVCaptureDevice.authorizationStatus(for: .video) },
        requestAccess: { completion in
            AVCaptureDevice.requestAccess(for: .video) { _ in
                DispatchQueue.main.async(execute: completion)
            }
        },
        applicationState: { UIApplication.shared.applicationState },
        sceneState: { [weak self] in self?.bridge?.webView?.window?.windowScene?.activationState })
    private var document = 0
    // Read and written only on Capacitor's serial bridge queue.
    private var workerDocument = 0

    override public func load() {
        scans = QrScanController(factory: { [weak self] bounds, callbacks in
            guard let webView = self?.bridge?.webView else {
                throw QrScannerFailure(code: "APP_INACTIVE", message: "The WebView is unavailable.")
            }
            let camera = try QrCameraSession(webView: webView, bounds: bounds, callbacks: callbacks)
            camera.start()
            return camera
        }, codes: { [weak self] id, values in
            self?.notifyListeners("codesScanned", data: ["scanId": id, "values": values])
        }, ended: { [weak self] event in
            var data: [String: Any] = ["scanId": event.scanId, "reason": event.reason]
            if let error = event.error {
                data["code"] = error.code
                data["message"] = error.message
            }
            self?.notifyListeners("scanEnded", data: data)
        })
        let center = NotificationCenter.default
        notifications = [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.scans.pause()
            },
            center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] notification in
                guard let self, let scene = notification.object as? UIScene,
                      scene === self.bridge?.webView?.window?.windowScene else { return }
                self.scans.pause()
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                self?.permissions.applicationDidBecomeActive()
            },
            center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] _ in
                self?.permissions.finishIfActive()
            }
        ]
        // Capacitor reloads this same WebView when its renderer terminates.
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            if change.newValue == true { self?.resetDocument() }
        }
    }

    deinit {
        for observer in notifications { NotificationCenter.default.removeObserver(observer) }
        let controller = scans
        DispatchQueue.main.async { controller?.reset() }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        dispatch(call) { [self] in call.resolve(["camera": permissions.state]) }
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        dispatch(call) { [self] in
            guard AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil else {
                throw QrScannerFailure(code: "NO_CAMERA", message: "No rear camera is available.")
            }
            permissions.request { state in call.resolve(["camera": state]) }
        }
    }

    @objc public func startScan(_ call: CAPPluginCall) {
        dispatch(call) { [self] in
            let id = try scanId(call)
            let bounds = try previewBounds(call)
            guard permissions.canStartScan else {
                throw QrScannerFailure(code: "APP_INACTIVE", message: "The app must be active to scan QR codes.")
            }
            guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                throw QrScannerFailure(code: "PERMISSION_DENIED", message: "Camera permission is required.")
            }
            scans.start(id: id, bounds: bounds, completion: result(call))
        }
    }

    @objc public func updatePreviewBounds(_ call: CAPPluginCall) {
        dispatch(call) { [self] in
            scans.update(id: try scanId(call), bounds: try previewBounds(call), completion: result(call))
        }
    }

    @objc public func animatePreview(_ call: CAPPluginCall) {
        dispatch(call) { [self] in
            let id = try scanId(call)
            guard let from = number(call.options["fromScale"]),
                  let to = number(call.options["toScale"]),
                  let duration = number(call.options["duration"]),
                  let rawEasing = call.options["easing"] as? [Any],
                  rawEasing.count == 4 else {
                throw QrScannerFailure(code: "INVALID_ARGUMENT", message: "Preview animation requires numeric scales, duration and four easing control points.")
            }
            let easing = rawEasing.compactMap(number)
            let animation = try QrPreviewAnimation(fromScale: from, toScale: to, duration: duration, easing: easing)
            scans.animate(id: id, animation: animation, completion: result(call))
        }
    }

    @objc public func stopScan(_ call: CAPPluginCall) {
        dispatch(call) { [self] in
            scans.stop(id: try scanId(call), completion: result(call))
        }
    }

    private func dispatch(_ call: CAPPluginCall, action: @escaping () throws -> Void) {
        let source = workerDocument
        DispatchQueue.main.async { [weak self] in
            guard let self, source == self.document else { return }
            do {
                try action()
            } catch {
                let failure = error as? QrScannerFailure
                    ?? QrScannerFailure(code: "CAMERA_ERROR", message: error.localizedDescription)
                call.reject(failure.message, failure.code)
            }
        }
    }

    private func resetDocument() {
        document += 1
        let next = document
        scans.reset()
        permissions.resetDocument()
        // Old queued bridge calls retain their original document generation.
        (bridge as? CapacitorBridge)?.dispatchQueue.async { [weak self] in self?.workerDocument = next }
    }

    private func scanId(_ call: CAPPluginCall) throws -> String {
        guard let id = call.getString("scanId"), !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw QrScannerFailure(code: "INVALID_ARGUMENT", message: "scanId must be a nonblank string.")
        }
        return id
    }

    private func previewBounds(_ call: CAPPluginCall) throws -> QrPreviewBounds {
        guard let value = call.getObject("previewBounds"),
              let x = number(value["x"]), let y = number(value["y"]),
              let width = number(value["width"]), let height = number(value["height"]) else {
            throw QrScannerFailure(code: "INVALID_ARGUMENT", message: "previewBounds must contain numeric x, y, width and height.")
        }
        let bounds = try QrPreviewBounds(x: x, y: y, width: width, height: height)
        if let webView = bridge?.webView, webView.bounds.width > 0, webView.bounds.height > 0 {
            _ = try bounds.rect(in: webView.bounds, scale: webView.window?.screen.scale ?? UIScreen.main.scale)
        }
        return bounds
    }

    private func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number.doubleValue
    }

    private func result(_ call: CAPPluginCall) -> QrScanController.Completion {
        { result in
            switch result {
            case .success: call.resolve()
            case .failure(let error): call.reject(error.message, error.code)
            }
        }
    }
}
