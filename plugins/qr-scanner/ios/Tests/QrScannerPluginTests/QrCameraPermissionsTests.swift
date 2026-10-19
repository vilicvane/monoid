import AVFoundation
import Capacitor
import UIKit
import XCTest
@testable import QrScannerPlugin

final class QrCameraPermissionsTests: XCTestCase {
    func testCameraLessSimulatorRejectsPermissionRequestWithoutWaitingForActivation() throws {
        #if targetEnvironment(simulator)
        guard AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) == nil else {
            throw XCTSkip("This simulator provides a camera.")
        }
        let rejected = expectation(description: "A camera-less device cannot present a scanner permission prompt")
        let plugin = QrScannerPlugin()
        let call = try XCTUnwrap(CAPPluginCall(callbackId: "permission", methodName: "requestPermissions", options: [:],
            success: { _, _ in XCTFail("Permission request should report no camera") },
            error: { error in
                XCTAssertEqual(error?.code, "NO_CAMERA")
                rejected.fulfill()
            }))
        plugin.requestPermissions(call)
        withExtendedLifetime(plugin) { wait(for: [rejected], timeout: 5) }
        #else
        throw XCTSkip("Camera-less simulator behavior only")
        #endif
    }

    func testPermissionReplyWhileSceneIsActiveWaitsForApplicationActivation() {
        let fixture = Fixture()
        fixture.permissions.request { fixture.replies.append($0) }
        fixture.applicationState = .inactive
        fixture.completeRequest(.authorized)

        XCTAssertEqual(fixture.sceneState, .foregroundActive)
        XCTAssertFalse(fixture.permissions.isAppActive)
        XCTAssertTrue(fixture.replies.isEmpty)
        fixture.permissions.finishIfActive()
        XCTAssertTrue(fixture.replies.isEmpty)

        fixture.applicationState = .active
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertEqual(fixture.replies, ["granted"])
        XCTAssertTrue(fixture.permissions.isAppActive)
        fixture.permissions.finishIfActive()
        XCTAssertEqual(fixture.replies.count, 1)
    }

    func testApplicationActivationStillWaitsForTheOwningScene() {
        let fixture = Fixture()
        fixture.permissions.request { fixture.replies.append($0) }
        fixture.sceneState = .foregroundInactive
        fixture.completeRequest(.authorized)
        fixture.permissions.applicationDidBecomeActive()

        XCTAssertFalse(fixture.permissions.isAppActive)
        XCTAssertTrue(fixture.replies.isEmpty)
        fixture.sceneState = .foregroundActive
        fixture.permissions.finishIfActive()
        XCTAssertEqual(fixture.replies, ["granted"])
    }

    func testActivationBeforeAuthorizationReplyDoesNotResolveEarly() {
        let fixture = Fixture()
        fixture.permissions.request { fixture.replies.append($0) }
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertTrue(fixture.replies.isEmpty)

        fixture.completeRequest(.authorized)
        XCTAssertEqual(fixture.replies, ["granted"])
    }

    func testBackgroundedPermissionRequestCannotEnableCameraUntilForeground() {
        let fixture = Fixture()
        fixture.permissions.request { fixture.replies.append($0) }
        fixture.applicationState = .background
        fixture.sceneState = .background
        fixture.completeRequest(.authorized)
        fixture.permissions.finishIfActive()
        XCTAssertFalse(fixture.permissions.isAppActive)
        XCTAssertTrue(fixture.replies.isEmpty)

        fixture.applicationState = .active
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertTrue(fixture.replies.isEmpty)
        fixture.sceneState = .foregroundActive
        fixture.permissions.finishIfActive()
        XCTAssertEqual(fixture.replies, ["granted"])
    }

    func testConcurrentRequestsShareOnePromptAndReportDenialAfterActivation() {
        let fixture = Fixture()
        fixture.permissions.request { fixture.replies.append($0) }
        fixture.permissions.request { fixture.replies.append($0) }
        XCTAssertEqual(fixture.requestCount, 1)
        fixture.applicationState = .inactive
        fixture.completeRequest(.denied)
        XCTAssertTrue(fixture.replies.isEmpty)
        fixture.applicationState = .active
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertEqual(fixture.replies, ["denied", "denied"])

        fixture.permissions.request { fixture.replies.append($0) }
        XCTAssertEqual(fixture.requestCount, 1)
        XCTAssertEqual(fixture.replies, ["denied", "denied", "denied"])
    }

    func testReloadDiscardsOldRepliesWithoutDuplicatingTheSystemPrompt() {
        let fixture = Fixture()
        fixture.permissions.request { _ in XCTFail("Reply belongs to the old document") }
        fixture.permissions.resetDocument()
        fixture.permissions.request { fixture.replies.append($0) }
        XCTAssertEqual(fixture.requestCount, 1)

        fixture.completeRequest(.authorized)
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertEqual(fixture.replies, ["granted"])
    }

    func testAuthorizationCallbackBeforePromptDeactivationCannotStartCamera() {
        let fixture = Fixture()
        fixture.permissions.request { fixture.replies.append($0) }
        fixture.completeRequest(.authorized)

        // Real iPhone order: the authorization callback initially sees both
        // application and scene active; the prompt deactivates them afterward.
        XCTAssertTrue(fixture.permissions.isAppActive)
        XCTAssertEqual(fixture.permissions.state, "granted")
        XCTAssertFalse(fixture.permissions.canStartScan)
        fixture.permissions.finishIfActive()
        XCTAssertTrue(fixture.replies.isEmpty)

        // A second caller can already observe granted permission in this gap.
        fixture.permissions.request { fixture.replies.append($0) }
        XCTAssertEqual(fixture.requestCount, 1)
        XCTAssertTrue(fixture.replies.isEmpty)

        fixture.sceneState = .foregroundInactive
        fixture.applicationState = .inactive
        fixture.permissions.finishIfActive()
        XCTAssertFalse(fixture.permissions.canStartScan)
        fixture.sceneState = .foregroundActive
        fixture.permissions.finishIfActive()
        XCTAssertTrue(fixture.replies.isEmpty)

        fixture.applicationState = .active
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertEqual(fixture.replies, ["granted", "granted"])
        XCTAssertTrue(fixture.permissions.canStartScan)
    }

    func testReloadAfterGrantStillWaitsForTheOutstandingPromptActivation() {
        let fixture = Fixture()
        fixture.permissions.request { _ in XCTFail("Reply belongs to the old document") }
        fixture.completeRequest(.authorized)
        fixture.permissions.resetDocument()
        fixture.permissions.request { fixture.replies.append($0) }

        XCTAssertTrue(fixture.replies.isEmpty)
        XCTAssertFalse(fixture.permissions.canStartScan)
        fixture.permissions.applicationDidBecomeActive()
        XCTAssertEqual(fixture.replies, ["granted"])
        XCTAssertEqual(fixture.requestCount, 1)
    }

    func testGrantedPermissionDoesNotBypassAppOrSceneActivity() {
        let fixture = Fixture()
        fixture.status = .authorized
        fixture.applicationState = .inactive
        fixture.permissions.request { fixture.replies.append($0) }
        XCTAssertTrue(fixture.replies.isEmpty)
        XCTAssertFalse(fixture.permissions.isAppActive)
        fixture.applicationState = .active
        fixture.sceneState = nil
        fixture.permissions.finishIfActive()
        XCTAssertTrue(fixture.replies.isEmpty)
        XCTAssertFalse(fixture.permissions.isAppActive)

        fixture.sceneState = .foregroundActive
        fixture.permissions.finishIfActive()
        XCTAssertEqual(fixture.replies, ["granted"])
        XCTAssertEqual(fixture.requestCount, 0)
    }

    private final class Fixture {
        var status = AVAuthorizationStatus.notDetermined
        var applicationState = UIApplication.State.active
        var sceneState: UIScene.ActivationState? = .foregroundActive
        var requestCount = 0
        var replies: [String] = []
        private var completion: (() -> Void)?

        lazy var permissions = QrCameraPermissions(
            authorizationStatus: { [unowned self] in status },
            requestAccess: { [unowned self] callback in
                requestCount += 1
                completion = callback
            },
            applicationState: { [unowned self] in applicationState },
            sceneState: { [unowned self] in sceneState })

        func completeRequest(_ status: AVAuthorizationStatus) {
            self.status = status
            let callback = completion
            completion = nil
            callback?()
        }
    }
}
