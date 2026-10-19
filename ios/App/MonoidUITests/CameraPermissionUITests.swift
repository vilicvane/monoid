import XCTest

@MainActor
final class CameraPermissionUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "app.monoid")
    private let cameraUsage = "Scan QR codes for wallet connections and addresses."

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        if let testRun, testRun.totalFailureCount > 0 {
            attachScreenshot("Failure")
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "Monoid accessibility hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
    }

    func testFirstCameraAuthorizationStartsPreview() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("This test requires an iPhone with a real camera.")
        #endif

        // Scope the reset to this app and this resource. Preserve app data and all
        // other permissions; do not uninstall or reset the device's privacy settings.
        app.resetAuthorizationStatus(for: .camera)
        app.launch()

        let webView = app.webViews.firstMatch
        let scan = webView.buttons["Scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 20), "Monoid must expose the Scan navigation button.")
        scan.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let systemAlert = springboard.alerts.containing(.staticText, identifier: cameraUsage).firstMatch
        let appAlert = app.alerts.containing(.staticText, identifier: cameraUsage).firstMatch
        let permissionAppeared = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in systemAlert.exists || appAlert.exists }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [permissionAppeared], timeout: 20), .completed,
                       "Resetting camera authorization must restore the first-use permission prompt.")
        attachScreenshot("First camera authorization")

        let alert = systemAlert.exists ? systemAlert : appAlert
        let allow = alert.buttons.matching(NSPredicate(
            format: "label IN %@", ["Allow", "允许", "允許", "好", "OK"])).firstMatch
        XCTAssertTrue(allow.exists, "Only accept the verified camera authorization alert.")
        allow.tap()

        // Do not reactivate the app or switch tabs: either would conceal the
        // first-authorization lifecycle bug. This accessible header is exposed
        // only once startScan has delivered the first native frame and revealed it.
        let ready = webView.staticTexts["WalletConnect / Passkey"]
        let clipboard = webView.buttons["Clipboard"]
        let cameraReady = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                ready.exists && clipboard.exists && clipboard.isEnabled && clipboard.isHittable
            }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [cameraReady], timeout: 20), .completed,
                       "The camera must open after the first grant without leaving the Scan page.")

        let failure = webView.staticTexts.matching(NSPredicate(format: "label IN %@", [
            "Scanning paused",
            "Allow camera access to scan",
            "Camera scanning is unavailable here",
            "Could not scan. Please try again."
        ])).firstMatch
        let staysScanning = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in failure.exists || !ready.exists }, object: nil)
        staysScanning.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [staysScanning], timeout: 3), .completed,
                       "The first camera preview must not immediately pause or fail.")
        attachScreenshot("Camera ready after first grant")
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
