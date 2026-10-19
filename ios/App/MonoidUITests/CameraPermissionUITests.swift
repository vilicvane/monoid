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

    func testForegroundResumesCamera() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("This test requires an iPhone with a real camera.")
        #endif

        app.launch()
        let webView = app.webViews.firstMatch
        let scan = webView.buttons["Scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 20))
        scan.tap()

        let ready = webView.staticTexts["WalletConnect / Passkey"]
        XCTAssertTrue(ready.waitForExistence(timeout: 20),
                      "Grant camera access first, or run the first-authorization test with this test.")

        for attempt in 1...2 {
            backgroundAndActivate()
            let resumed = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in
                    ready.exists && webView.buttons["Clipboard"].isHittable
                }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [resumed], timeout: 20), .completed,
                           "Returning to the app must resume the camera without navigating away or pressing Resume.")
            let paused = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in
                    webView.staticTexts["Scanning paused"].exists || !ready.exists
                }, object: nil)
            paused.isInverted = true
            XCTAssertEqual(XCTWaiter.wait(for: [paused], timeout: 3), .completed,
                           "A late native pause event must not pause the resumed camera.")
            attachScreenshot("Camera resumed \(attempt)")
        }

        webView.buttons["Home"].tap()
        let leftScan = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in !ready.exists }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [leftScan], timeout: 10), .completed)
        backgroundAndActivate()
        XCTAssertTrue(webView.buttons["Scan"].waitForExistence(timeout: 10))
        XCTAssertFalse(ready.exists, "Returning to the app must not reopen a scanner the user left.")
    }

    func testPopupForegroundResumesCameraAndDismissalStaysClosed() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("This test requires an iPhone with a real camera.")
        #endif

        app.launch()
        let webView = app.webViews.firstMatch
        let home = webView.buttons["Home"]
        XCTAssertTrue(home.waitForExistence(timeout: 20))
        home.tap()

        let bitcoin = webView.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "Bitcoin", "Send and receive BTC.")).firstMatch
        guard bitcoin.waitForExistence(timeout: 10) else {
            throw XCTSkip("This test requires an existing Bitcoin wallet in Safe.")
        }
        bitcoin.tap()

        // These controls only open existing public wallet metadata. Do not add
        // wallets, edit addresses, review a payment, or start a signing operation.
        let groups = webView.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "Show ", " accounts"))
        for _ in 0..<groups.count {
            groups.firstMatch.tap()
        }
        let wallets = webView.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "bc1"))
        guard wallets.firstMatch.waitForExistence(timeout: 10) else {
            throw XCTSkip("No existing Bitcoin wallet is available for this test.")
        }
        let walletCount = wallets.count
        let send = webView.buttons["Send"]
        var foundSpendableWallet = false
        for index in 0..<walletCount {
            if index > 0 {
                home.tap()
                XCTAssertTrue(bitcoin.waitForExistence(timeout: 10))
                bitcoin.tap()
                for _ in 0..<groups.count {
                    groups.firstMatch.tap()
                }
                XCTAssertTrue(wallets.element(boundBy: index).waitForExistence(timeout: 10))
            }
            wallets.element(boundBy: index).tap()
            let spendable = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in send.exists && send.isHittable }, object: nil)
            if XCTWaiter.wait(for: [spendable], timeout: 15) == .completed {
                foundSpendableWallet = true
                break
            }
        }
        guard foundSpendableWallet else {
            throw XCTSkip("No existing Bitcoin wallet currently exposes Send with a spendable balance.")
        }
        send.tap()
        let scanAddress = webView.descendants(matching: .any)
            .matching(identifier: "Scan address").firstMatch
        XCTAssertTrue(scanAddress.waitForExistence(timeout: 10))
        scanAddress.tap()

        let ready = webView.descendants(matching: .any).matching(identifier: "Camera preview active").firstMatch
        XCTAssertTrue(ready.waitForExistence(timeout: 20),
                      "Grant camera access first, or run the first-authorization test with this test.")
        XCTAssertFalse(webView.buttons["Cancel"].exists, "The Bitcoin scanner must dismiss through its outside area.")

        for attempt in 1...2 {
            backgroundAndActivate()
            XCTAssertTrue(ready.waitForExistence(timeout: 20),
                          "Returning to the app must automatically resume the Bitcoin camera preview.")
            let interrupted = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in
                    !ready.exists || webView.buttons["Resume"].exists || webView.staticTexts["Scanning paused"].exists
                }, object: nil)
            interrupted.isInverted = true
            XCTAssertEqual(XCTWaiter.wait(for: [interrupted], timeout: 3), .completed,
                           "The resumed popup must stay scanning after late native pause notifications.")
            attachScreenshot("Bitcoin camera resumed \(attempt)")
        }

        // The dialog has 14 pt of top padding; this point is safely outside it.
        let outside = webView.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: webView.frame.width / 2,
            dy: ready.frame.minY - webView.frame.minY - 40))
        outside.tap()
        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in !ready.exists && scanAddress.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 10), .completed)

        backgroundAndActivate()
        XCTAssertTrue(scanAddress.waitForExistence(timeout: 10))
        let reopened = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in ready.exists || !scanAddress.isHittable }, object: nil)
        reopened.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [reopened], timeout: 3), .completed,
                       "A dismissed Bitcoin scanner must not reopen when the app returns to the foreground.")
    }

    private func backgroundAndActivate() {
        XCUIDevice.shared.press(.home)
        let background = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                self.app.state == .runningBackground || self.app.state == .runningBackgroundSuspended
            }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [background], timeout: 10), .completed)
        app.activate()
    }
}
