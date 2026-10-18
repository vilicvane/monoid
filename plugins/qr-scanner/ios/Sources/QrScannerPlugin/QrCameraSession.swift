import AVFoundation
import Foundation
import UIKit
import WebKit

/// Session configuration and metadata delivery use a serial queue; UIKit and callbacks use main.
final class QrCameraSession: NSObject, QrScanSession, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let metadata = AVCaptureMetadataOutput()
    private let queue = DispatchQueue(label: "app.monoid.qr-scanner.capture", qos: .userInitiated)
    private let surface: QrPreviewSurface
    private let callbacks: QrScanCallbacks
    private var previewObservation: NSKeyValueObservation?
    private var notifications: [NSObjectProtocol] = []
    private var started = false
    private var configured = false
    private var closing = false
    private var geometryRevision = 0
    // Only accessed by the capture queue. Main rejects metadata queued for an older layout.
    private var metadataRevision = 0

    init(webView: WKWebView, bounds: QrPreviewBounds, callbacks: QrScanCallbacks) throws {
        self.callbacks = callbacks
        surface = try QrPreviewSurface(webView: webView, bounds: bounds, session: session)
        super.init()
        surface.onLayoutChanged = { [weak self] in self?.refreshLayout() }
    }

    func start() {
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        previewObservation = surface.preview.previewLayer.observe(\.isPreviewing, options: [.new]) { [weak self] _, change in
            guard change.newValue == true else { return }
            DispatchQueue.main.async { self?.previewReady() }
        }
        let center = NotificationCenter.default
        notifications = [
            center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] notification in
                // Before configuration completes, its explicit errors (including NO_CAMERA)
                // take precedence over errors from attaching an empty preview on a simulator.
                guard let self, self.configured else { return }
                let error = notification.userInfo?[AVCaptureSessionErrorKey] as? Error
                self.fail(QrScannerFailure(code: "CAMERA_ERROR", message: error?.localizedDescription ?? "Camera capture failed."))
            },
            center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main) { [weak self] _ in
                self?.fail(QrScannerFailure(code: "CAMERA_ERROR", message: "Camera capture was interrupted."))
            },
            center.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                self?.refreshLayout()
            }
        ]
        queue.async { [self] in
            do {
                try configure()
                DispatchQueue.main.async { [self] in
                    guard !closing else { return }
                    configured = true
                    refreshLayout()
                    guard !closing else { return }
                    queue.async { [self] in session.startRunning() }
                }
            } catch {
                let failure = error as? QrScannerFailure
                    ?? QrScannerFailure(code: "CAMERA_ERROR", message: error.localizedDescription)
                DispatchQueue.main.async { [weak self] in self?.fail(failure) }
            }
        }
    }

    private func configure() throws {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw QrScannerFailure(code: "NO_CAMERA", message: "No rear camera is available.")
        }
        let input = try AVCaptureDeviceInput(device: camera)
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
        guard session.canAddInput(input), session.canAddOutput(metadata) else {
            throw QrScannerFailure(code: "CAMERA_ERROR", message: "The camera cannot provide QR scanning output.")
        }
        session.addInput(input)
        session.addOutput(metadata)
        guard metadata.availableMetadataObjectTypes.contains(.qr) else {
            throw QrScannerFailure(code: "DETECTION_ERROR", message: "QR detection is unavailable on this camera.")
        }
        metadata.metadataObjectTypes = [.qr]
        metadata.setMetadataObjectsDelegate(self, queue: queue)
    }

    func update(_ bounds: QrPreviewBounds) throws {
        try surface.update(bounds)
    }

    func animate(_ animation: QrPreviewAnimation) {
        surface.animate(animation)
    }

    private func refreshLayout() {
        guard !closing else { return }
        do {
            try surface.layout()
        } catch {
            fail(error as? QrScannerFailure ?? QrScannerFailure(code: "CAMERA_ERROR", message: error.localizedDescription))
            return
        }
        guard configured else { return }
        surface.orientPreview()
        geometryRevision += 1
        let revision = geometryRevision
        queue.async { [self] in metadataRevision = revision }
    }

    private func previewReady() {
        guard !closing, !started, surface.preview.previewLayer.isPreviewing else { return }
        started = true
        previewObservation = nil
        callbacks.started()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let revision = metadataRevision
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closing, self.started, revision == self.geometryRevision else { return }
            let layer = self.surface.preview.previewLayer
            guard layer.isPreviewing else { return }
            let values = metadataObjects.compactMap { object -> String? in
                guard let code = layer.transformedMetadataObject(for: object) as? AVMetadataMachineReadableCodeObject,
                      code.type == .qr,
                      QrPreviewBounds.contains(codeBounds: code.bounds, corners: code.corners, in: layer.bounds) else { return nil }
                return code.stringValue
            }
            if !values.isEmpty { self.callbacks.codes(values) }
        }
    }

    private func fail(_ error: QrScannerFailure) {
        guard !closing else { return }
        callbacks.failed(error)
    }

    func close(completion: @escaping () -> Void) {
        closing = true
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
        previewObservation = nil
        for observer in notifications { NotificationCenter.default.removeObserver(observer) }
        notifications.removeAll()
        surface.hide()
        queue.async { [self] in
            metadata.setMetadataObjectsDelegate(nil, queue: nil)
            session.stopRunning()
            session.beginConfiguration()
            for input in session.inputs { session.removeInput(input) }
            for output in session.outputs { session.removeOutput(output) }
            session.commitConfiguration()
            DispatchQueue.main.async { [self] in
                surface.close()
                completion()
            }
        }
    }
}
