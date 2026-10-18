import XCTest
@testable import QrScannerPlugin

final class QrScanControllerTests: XCTestCase {
    private let bounds = try! QrPreviewBounds(x: 0, y: 0, width: 1, height: 1)
    private let animation = try! QrPreviewAnimation(fromScale: 0.5, toScale: 1, duration: 300, easing: [0.2, 0, 0.8, 1])
    private var camera: Camera!
    private var scans: QrScanController!
    private var codes: [[String]] = []
    private var ended: [QrScanEnded] = []

    override func setUp() {
        camera = Camera()
        scans = QrScanController(factory: { [self] bounds, callbacks in
            camera.opens += 1
            camera.bounds = bounds
            camera.callbacks = callbacks
            return camera
        }, codes: { [self] _, values in codes.append(values) }, ended: { [self] in ended.append($0) })
    }

    override func tearDown() {
        camera.finishClose?()
        scans = nil
        camera = nil
    }

    func testRetiredAndBusyStartsDoNotOpenCamera() {
        let retired = ResultRecorder()
        scans.stop(id: "cancelled", completion: retired.record)
        scans.start(id: "cancelled", bounds: bounds, completion: retired.record)
        scans.start(id: "first", bounds: bounds, completion: ResultRecorder().record)
        let busy = ResultRecorder()
        scans.start(id: "second", bounds: bounds, completion: busy.record)
        XCTAssertEqual(retired.successes, 1)
        XCTAssertEqual(retired.errors, ["SCAN_CLOSED"])
        XCTAssertEqual(busy.errors, ["BUSY"])
        XCTAssertEqual(camera.opens, 1)
    }

    func testDetectionWaitsForPreviewAndPreservesContinuousRawValues() {
        let start = ResultRecorder()
        scans.start(id: "first", bounds: bounds, completion: start.record)
        camera.callbacks.codes(["too soon"])
        XCTAssertEqual(start.successes, 0)
        XCTAssertTrue(codes.isEmpty)
        camera.callbacks.started()
        camera.callbacks.started()
        camera.callbacks.codes([" raw QR ", " raw QR "])
        camera.callbacks.codes([" raw QR "])
        XCTAssertEqual(start.successes, 1)
        XCTAssertEqual(codes, [[" raw QR ", " raw QR "], [" raw QR "]])
    }

    func testPendingCancellationWaitsForCleanupAndIgnoresLateCallbacks() {
        let start = ResultRecorder()
        let stop = ResultRecorder()
        scans.start(id: "first", bounds: bounds, completion: start.record)
        scans.stop(id: "first", completion: stop.record)
        scans.stop(id: "first", completion: stop.record)
        camera.callbacks.started()
        camera.callbacks.codes(["late"])
        camera.callbacks.failed(QrScannerFailure(code: "CAMERA_ERROR", message: "late"))
        XCTAssertEqual(camera.closes, 1)
        XCTAssertEqual(stop.successes, 0)
        XCTAssertTrue(start.errors.isEmpty)
        camera.finishClose()
        XCTAssertEqual(stop.successes, 2)
        XCTAssertEqual(start.errors, ["CANCELLED"])
        XCTAssertTrue(ended.isEmpty)
        XCTAssertTrue(codes.isEmpty)
    }

    func testStoppingAnotherIdDoesNotStopCurrentScan() {
        scans.start(id: "first", bounds: bounds, completion: ResultRecorder().record)
        camera.callbacks.started()
        let stop = ResultRecorder()
        scans.stop(id: "other", completion: stop.record)
        camera.callbacks.codes(["active"])
        XCTAssertEqual(stop.successes, 1)
        XCTAssertEqual(camera.closes, 0)
        XCTAssertEqual(codes, [["active"]])
    }

    func testPauseEmitsOneEndedEventAfterCleanupAndNeverAutoRestarts() {
        scans.start(id: "first", bounds: bounds, completion: ResultRecorder().record)
        camera.callbacks.started()
        scans.pause()
        scans.pause()
        XCTAssertTrue(ended.isEmpty)
        camera.finishClose()
        XCTAssertEqual(ended.map(\.reason), ["app-paused"])
        XCTAssertNil(ended[0].error)
        let restart = ResultRecorder()
        scans.start(id: "first", bounds: bounds, completion: restart.record)
        XCTAssertEqual(restart.errors, ["SCAN_CLOSED"])
        XCTAssertEqual(camera.opens, 1)
    }

    func testStartupFailureRejectsButRuntimeFailureEmitsEvent() {
        let start = ResultRecorder()
        scans.start(id: "first", bounds: bounds, completion: start.record)
        camera.callbacks.failed(QrScannerFailure(code: "NO_CAMERA", message: "No camera"))
        camera.finishClose()
        XCTAssertEqual(start.errors, ["NO_CAMERA"])
        XCTAssertTrue(ended.isEmpty)
        scans.start(id: "second", bounds: bounds, completion: start.record)
        camera.callbacks.started()
        camera.callbacks.failed(QrScannerFailure(code: "CAMERA_ERROR", message: "Interrupted"))
        camera.finishClose()
        XCTAssertEqual(ended.map(\.reason), ["error"])
        XCTAssertEqual(ended[0].error?.code, "CAMERA_ERROR")
    }

    func testReloadSuppressesOldDocumentAndAllowsFreshIdsAfterCleanup() {
        let oldStart = ResultRecorder()
        scans.start(id: "first", bounds: bounds, completion: oldStart.record)
        let oldCallbacks = camera.callbacks!
        scans.reset()
        camera.finishClose()
        let newStart = ResultRecorder()
        scans.start(id: "first", bounds: bounds, completion: newStart.record)
        oldCallbacks.started()
        oldCallbacks.codes(["late"])
        oldCallbacks.failed(QrScannerFailure(code: "CAMERA_ERROR", message: "late"))
        XCTAssertTrue(oldStart.errors.isEmpty)
        XCTAssertEqual(newStart.successes, 0)
        XCTAssertTrue(codes.isEmpty)
        XCTAssertTrue(ended.isEmpty)
        camera.callbacks.started()
        XCTAssertEqual(newStart.successes, 1)
    }

    func testUpdateWorksWhilePendingButAnimationRequiresReadyPreview() throws {
        scans.start(id: "first", bounds: bounds, completion: ResultRecorder().record)
        let update = ResultRecorder()
        let next = try QrPreviewBounds(x: 0.1, y: 0.1, width: 0.8, height: 0.8)
        scans.update(id: "first", bounds: next, completion: update.record)
        XCTAssertEqual(camera.bounds, next)
        XCTAssertEqual(update.successes, 1)
        let pendingAnimation = ResultRecorder()
        scans.animate(id: "first", animation: animation, completion: pendingAnimation.record)
        XCTAssertEqual(pendingAnimation.errors, ["SCAN_CLOSED"])
        camera.callbacks.started()
        let activeAnimation = ResultRecorder()
        scans.animate(id: "first", animation: animation, completion: activeAnimation.record)
        XCTAssertEqual(activeAnimation.successes, 1)
        XCTAssertEqual(camera.animations, 1)
        XCTAssertEqual(camera.bounds, next)
        scans.pause()
        scans.update(id: "first", bounds: next, completion: update.record)
        scans.animate(id: "first", animation: animation, completion: activeAnimation.record)
        XCTAssertEqual(update.errors, ["SCAN_CLOSED"])
        XCTAssertEqual(activeAnimation.errors, ["SCAN_CLOSED"])
    }

    func testStaleAnimationCannotReachReplacementCamera() {
        scans.start(id: "first", bounds: bounds, completion: ResultRecorder().record)
        camera.callbacks.started()
        scans.stop(id: "first", completion: ResultRecorder().record)
        camera.finishClose()
        scans.start(id: "second", bounds: bounds, completion: ResultRecorder().record)
        camera.callbacks.started()
        let stale = ResultRecorder()
        scans.animate(id: "first", animation: animation, completion: stale.record)
        XCTAssertEqual(stale.errors, ["SCAN_CLOSED"])
        XCTAssertEqual(camera.animations, 0)
    }

    private final class Camera: QrScanSession {
        var opens = 0
        var closes = 0
        var animations = 0
        var bounds: QrPreviewBounds?
        var callbacks: QrScanCallbacks!
        var finishClose: (() -> Void)!

        func update(_ bounds: QrPreviewBounds) { self.bounds = bounds }
        func animate(_ animation: QrPreviewAnimation) { animations += 1 }
        func close(completion: @escaping () -> Void) {
            closes += 1
            finishClose = { [weak self] in
                self?.finishClose = nil
                completion()
            }
        }
    }

    private final class ResultRecorder {
        var successes = 0
        var errors: [String] = []

        func record(_ result: Result<Void, QrScannerFailure>) {
            switch result {
            case .success: successes += 1
            case .failure(let error): errors.append(error.code)
            }
        }
    }
}
