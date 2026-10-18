import Foundation

struct QrScannerFailure: LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? { message }
}

struct QrPreviewBounds: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(x: Double, y: Double, width: Double, height: Double) throws {
        guard [x, y, width, height].allSatisfy(\.isFinite),
              x >= 0, y >= 0, width > 0, height > 0,
              x + width <= 1, y + height <= 1 else {
            throw QrScannerFailure(code: "INVALID_ARGUMENT", message: "Preview bounds must have positive area inside the WebView viewport.")
        }
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    /// Round both edges in physical pixels so fractional layout updates agree at shared edges.
    func rect(in viewport: CGRect, scale: CGFloat) throws -> CGRect {
        let left = (x * viewport.width * scale).rounded() / scale
        let top = (y * viewport.height * scale).rounded() / scale
        let right = ((x + width) * viewport.width * scale).rounded() / scale
        let bottom = ((y + height) * viewport.height * scale).rounded() / scale
        guard right > left, bottom > top else {
            throw QrScannerFailure(code: "INVALID_ARGUMENT", message: "Preview bounds must cover at least one pixel.")
        }
        return CGRect(x: viewport.minX + left, y: viewport.minY + top, width: right - left, height: bottom - top)
    }

    /// Metadata has already been converted to preview-layer coordinates, including aspect fill and rotation.
    static func contains(codeBounds: CGRect, corners: [CGPoint], in crop: CGRect) -> Bool {
        guard codeBounds.width > 0, codeBounds.height > 0, corners.count == 4 else { return false }
        let points = corners + [
            CGPoint(x: codeBounds.minX, y: codeBounds.minY),
            CGPoint(x: codeBounds.maxX, y: codeBounds.maxY)
        ]
        return points.allSatisfy { point in
            point.x.isFinite && point.y.isFinite
                && point.x >= crop.minX && point.x <= crop.maxX
                && point.y >= crop.minY && point.y <= crop.maxY
        }
    }
}

struct QrPreviewAnimation {
    let fromScale: Double
    let toScale: Double
    let duration: Double
    let easing: [Double]

    init(fromScale: Double, toScale: Double, duration: Double, easing: [Double]) throws {
        let smallest = Double(Float.leastNonzeroMagnitude)
        let largest = Double(Float.greatestFiniteMagnitude)
        guard fromScale >= smallest, fromScale <= largest,
              toScale >= smallest, toScale <= largest,
              duration >= 0, duration <= Double(Int64.max),
              easing.count == 4, easing.allSatisfy(\.isFinite),
              (0...1).contains(easing[0]), (0...1).contains(easing[2]),
              abs(easing[1]) <= largest, abs(easing[3]) <= largest else {
            throw QrScannerFailure(code: "INVALID_ARGUMENT", message: "Preview animation requires positive finite scales, a nonnegative duration and valid cubic-bezier control points.")
        }
        self.fromScale = fromScale
        self.toScale = toScale
        self.duration = duration
        self.easing = easing
    }
}
