import AVFoundation
import UIKit
import WebKit

/// Native camera UI lives below the WebView; the app owns the transparent HTML opening.
final class QrPreviewSurface {
    let preview = PreviewView()
    var onLayoutChanged: (() -> Void)?

    private let webView: WKWebView
    private let container = UIView()
    private var bounds: QrPreviewBounds
    private let wasOpaque: Bool
    private let background: UIColor?
    private let scrollBackground: UIColor?
    private let underPageBackground: UIColor
    private var observations: [NSKeyValueObservation] = []
    private var closed = false

    init(webView: WKWebView, bounds: QrPreviewBounds, session: AVCaptureSession) throws {
        guard let parent = webView.superview else {
            throw QrScannerFailure(code: "APP_INACTIVE", message: "The WebView is not attached to a visible screen.")
        }
        _ = try bounds.rect(in: webView.bounds, scale: webView.window?.screen.scale ?? UIScreen.main.scale)
        self.webView = webView
        self.bounds = bounds
        wasOpaque = webView.isOpaque
        background = webView.backgroundColor
        scrollBackground = webView.scrollView.backgroundColor
        underPageBackground = webView.underPageBackgroundColor

        container.isUserInteractionEnabled = false
        container.backgroundColor = background
        preview.backgroundColor = .black
        preview.clipsToBounds = true
        preview.previewLayer.videoGravity = .resizeAspectFill
        preview.previewLayer.session = session
        container.addSubview(preview)
        parent.insertSubview(container, belowSubview: webView)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.underPageBackgroundColor = .clear

        try layout()
        observations = [
            webView.observe(\.bounds, options: [.new]) { [weak self] _, _ in self?.layoutChanged() },
            webView.observe(\.frame, options: [.new]) { [weak self] _, _ in self?.layoutChanged() }
        ]
    }

    func update(_ bounds: QrPreviewBounds) throws {
        _ = try bounds.rect(in: webView.bounds, scale: webView.window?.screen.scale ?? UIScreen.main.scale)
        self.bounds = bounds
        try layout()
        onLayoutChanged?()
    }

    func layout() throws {
        guard let parent = webView.superview else { return }
        let frame = try bounds.rect(in: CGRect(origin: .zero, size: webView.bounds.size),
            scale: webView.window?.screen.scale ?? UIScreen.main.scale)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.frame = webView.convert(webView.bounds, to: parent)
        // Do not assign frame while the preview has a scale transform.
        preview.bounds = CGRect(origin: .zero, size: frame.size)
        preview.center = CGPoint(x: frame.midX, y: frame.midY)
        CATransaction.commit()
    }

    func orientPreview() {
        guard let connection = preview.previewLayer.connection else { return }
        let orientation = webView.window?.windowScene?.interfaceOrientation ?? .portrait
        if #available(iOS 17.0, *) {
            let angle: CGFloat
            switch orientation {
            case .landscapeRight: angle = 0
            case .landscapeLeft: angle = 180
            case .portraitUpsideDown: angle = 270
            default: angle = 90
            }
            if connection.isVideoRotationAngleSupported(angle) {
                connection.videoRotationAngle = angle
            }
        } else if connection.isVideoOrientationSupported {
            switch orientation {
            case .landscapeLeft: connection.videoOrientation = .landscapeLeft
            case .landscapeRight: connection.videoOrientation = .landscapeRight
            case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
            default: connection.videoOrientation = .portrait
            }
        }
    }

    func animate(_ animation: QrPreviewAnimation) {
        let layer = preview.layer
        layer.removeAnimation(forKey: "qrPreviewScale")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.transform = CATransform3DMakeScale(animation.toScale, animation.toScale, 1)
        CATransaction.commit()
        guard animation.duration > 0 else { return }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = animation.fromScale
        scale.toValue = animation.toScale
        scale.duration = animation.duration / 1000
        scale.timingFunction = CAMediaTimingFunction(
            controlPoints: Float(animation.easing[0]), Float(animation.easing[1]),
            Float(animation.easing[2]), Float(animation.easing[3]))
        layer.add(scale, forKey: "qrPreviewScale")
    }

    func hide() {
        preview.layer.removeAnimation(forKey: "qrPreviewScale")
        preview.isHidden = true
    }

    func close() {
        guard !closed else { return }
        closed = true
        observations.removeAll()
        onLayoutChanged = nil
        hide()
        preview.previewLayer.session = nil
        webView.isOpaque = wasOpaque
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = scrollBackground
        webView.underPageBackgroundColor = underPageBackground
        container.removeFromSuperview()
    }

    private func layoutChanged() {
        guard !closed else { return }
        // Geometry validation and failures belong to the camera session callback.
        onLayoutChanged?()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
