import AVFoundation
import WebKit
import XCTest
@testable import QrScannerPlugin

@MainActor
final class QrPreviewSurfaceTests: XCTestCase {
    func testPreviewSitsBelowWebViewAndRestoresBackgrounds() throws {
        let parent = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let webView = WKWebView(frame: CGRect(x: 10, y: 20, width: 300, height: 600))
        parent.addSubview(webView)
        webView.isOpaque = true
        webView.backgroundColor = .red
        webView.scrollView.backgroundColor = .blue
        webView.underPageBackgroundColor = .green
        let underPageBackground = webView.underPageBackgroundColor
        let bounds = try QrPreviewBounds(x: 0.1, y: 0.2, width: 0.8, height: 0.6)
        let surface = try QrPreviewSurface(webView: webView, bounds: bounds, session: AVCaptureSession())
        XCTAssertEqual(parent.subviews.count, 2)
        XCTAssertTrue(parent.subviews.last === webView)
        XCTAssertFalse(webView.isOpaque)
        XCTAssertEqual(webView.backgroundColor, .clear)
        XCTAssertEqual(surface.preview.frame, CGRect(x: 30, y: 120, width: 240, height: 360))
        surface.close()
        XCTAssertEqual(parent.subviews.count, 1)
        XCTAssertTrue(webView.isOpaque)
        XCTAssertEqual(webView.backgroundColor, .red)
        XCTAssertEqual(webView.scrollView.backgroundColor, .blue)
        XCTAssertEqual(webView.underPageBackgroundColor, underPageBackground)
        surface.close()
        XCTAssertEqual(parent.subviews.count, 1)
    }

    func testScaleAnimationKeepsUnscaledCropWhenBoundsChange() throws {
        let parent = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let webView = WKWebView(frame: parent.bounds)
        parent.addSubview(webView)
        let bounds = try QrPreviewBounds(x: 0, y: 0, width: 1, height: 1)
        let surface = try QrPreviewSurface(webView: webView, bounds: bounds, session: AVCaptureSession())
        defer { surface.close() }
        let scale = try QrPreviewAnimation(fromScale: 0.5, toScale: 0.75, duration: 0, easing: [0, 0, 1, 1])
        surface.animate(scale)
        try surface.update(QrPreviewBounds(x: 0.25, y: 0.25, width: 0.5, height: 0.5))
        XCTAssertEqual(surface.preview.bounds, CGRect(x: 0, y: 0, width: 200, height: 400))
        XCTAssertEqual(surface.preview.center, CGPoint(x: 200, y: 400))
        XCTAssertEqual(surface.preview.layer.transform.m11, 0.75)
        XCTAssertNil(surface.preview.layer.animation(forKey: "qrPreviewScale"))
        surface.animate(try QrPreviewAnimation(fromScale: 0.5, toScale: 1, duration: 300, easing: [0.2, 0, 0.8, 1]))
        XCTAssertNotNil(surface.preview.layer.animation(forKey: "qrPreviewScale"))
        surface.hide()
        XCTAssertNil(surface.preview.layer.animation(forKey: "qrPreviewScale"))
    }

    func testSimulatorWithoutCameraFailsAndCleansUp() throws {
        #if targetEnvironment(simulator)
        guard AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) == nil else {
            throw XCTSkip("This simulator provides a camera.")
        }
        let parent = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let webView = WKWebView(frame: parent.bounds)
        parent.addSubview(webView)
        let restored = expectation(description: "No-camera startup restores the WebView")
        var camera: QrCameraSession!
        camera = try QrCameraSession(webView: webView,
            bounds: QrPreviewBounds(x: 0, y: 0, width: 1, height: 1),
            callbacks: QrScanCallbacks(started: { XCTFail("A camera-less simulator must not start") },
                codes: { _ in XCTFail("A camera-less simulator must not scan") },
                failed: { error in
                    XCTAssertEqual(error.code, "NO_CAMERA")
                    camera.close {
                        XCTAssertEqual(parent.subviews.count, 1)
                        restored.fulfill()
                    }
                }))
        camera.start()
        wait(for: [restored], timeout: 5)
        #else
        throw XCTSkip("Camera-less simulator behavior only")
        #endif
    }
}
