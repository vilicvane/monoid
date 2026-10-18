import XCTest
@testable import QrScannerPlugin

final class QrPreviewGeometryTests: XCTestCase {
    func testBoundsMapToWebViewCoordinatesWithoutAddingSafeInsets() throws {
        let bounds = try QrPreviewBounds(x: 0.1, y: 0.25, width: 0.8, height: 0.5)
        let frame = try bounds.rect(in: CGRect(x: 10, y: 20, width: 400, height: 800), scale: 3)
        XCTAssertEqual(frame, CGRect(x: 50, y: 220, width: 320, height: 400))
    }

    func testPixelEdgesRoundConsistently() throws {
        let left = try QrPreviewBounds(x: 0, y: 0, width: 0.5, height: 1)
        let right = try QrPreviewBounds(x: 0.5, y: 0, width: 0.5, height: 1)
        let viewport = CGRect(x: 0, y: 0, width: 101, height: 50)
        XCTAssertEqual(try left.rect(in: viewport, scale: 3).maxX, try right.rect(in: viewport, scale: 3).minX)
        let tiny = try QrPreviewBounds(x: 0.2, y: 0.2, width: 0.0001, height: 0.0001)
        XCTAssertThrowsError(try tiny.rect(in: viewport, scale: 3))
    }

    func testBoundsRejectNonfiniteAndOutsideViewportValues() {
        for value in [Double.nan, Double.infinity, -1] {
            XCTAssertThrowsError(try QrPreviewBounds(x: value, y: 0, width: 0.5, height: 0.5))
        }
        XCTAssertThrowsError(try QrPreviewBounds(x: 0.5, y: 0, width: 0.6, height: 1))
        XCTAssertThrowsError(try QrPreviewBounds(x: 0, y: 0, width: 0, height: 1))
        XCTAssertThrowsError(try QrPreviewBounds(x: 0, y: 0, width: 1, height: .nan))
    }

    func testCropAcceptsBoundaryCornersAndRejectsPartlyClippedQr() {
        let crop = CGRect(x: 0, y: 0, width: 100, height: 100)
        let corners = [CGPoint(x: 0, y: 50), CGPoint(x: 50, y: 0), CGPoint(x: 100, y: 50), CGPoint(x: 50, y: 100)]
        XCTAssertTrue(QrPreviewBounds.contains(codeBounds: crop, corners: corners, in: crop))
        XCTAssertFalse(QrPreviewBounds.contains(codeBounds: crop, corners: corners, in: crop.insetBy(dx: 1, dy: 1)))
        let outside = [CGPoint(x: -1, y: 50)] + corners.dropFirst()
        XCTAssertFalse(QrPreviewBounds.contains(codeBounds: crop, corners: outside, in: crop))
        XCTAssertFalse(QrPreviewBounds.contains(codeBounds: crop.insetBy(dx: -1, dy: 0), corners: corners, in: crop))
    }

    func testCropRejectsIncompleteAndInvalidGeometry() {
        let crop = CGRect(x: 0, y: 0, width: 100, height: 100)
        XCTAssertFalse(QrPreviewBounds.contains(codeBounds: crop, corners: [], in: crop))
        XCTAssertFalse(QrPreviewBounds.contains(codeBounds: .zero, corners: Array(repeating: .zero, count: 4), in: crop))
        XCTAssertFalse(QrPreviewBounds.contains(codeBounds: crop,
            corners: Array(repeating: CGPoint(x: CGFloat.nan, y: 0), count: 4), in: crop))
    }

    func testAnimationsAcceptOvershootingEasingAndZeroDuration() throws {
        let animation = try QrPreviewAnimation(fromScale: 0.5, toScale: 1, duration: 0, easing: [0.2, -0.5, 0.8, 1.5])
        XCTAssertEqual(animation.duration, 0)
        XCTAssertEqual(animation.easing, [0.2, -0.5, 0.8, 1.5])
    }

    func testAnimationsRejectInvalidNativeNumbersAndCurves() {
        for scale in [Double.nan, Double.infinity, -1, 0, Double.leastNonzeroMagnitude] {
            XCTAssertThrowsError(try QrPreviewAnimation(fromScale: scale, toScale: 1, duration: 100, easing: [0, 0, 1, 1]))
        }
        for duration in [Double.nan, Double.infinity, -1] {
            XCTAssertThrowsError(try QrPreviewAnimation(fromScale: 0.5, toScale: 1, duration: duration, easing: [0, 0, 1, 1]))
        }
        for curve in [[0.0, 1.0], [-0.1, 0, 1, 1], [0, 0, 1.1, 1], [0, .nan, 1, 1]] {
            XCTAssertThrowsError(try QrPreviewAnimation(fromScale: 0.5, toScale: 1, duration: 100, easing: curve))
        }
    }
}
