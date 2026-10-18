import LocalAuthentication
import XCTest

@testable import BiometricVaultPlugin

final class VaultControllerTests: XCTestCase {
    private var control: ManualQueue!
    private var worker: ManualQueue!
    private var store: MemoryStore!
    private var authentications: [Authentication]!
    private var controller: VaultController!
    private var time: TimeInterval = 0
    private var expirations: [() -> Void]!
    private var requestNumber = 0

    override func setUp() {
        control = ManualQueue()
        worker = ManualQueue()
        store = MemoryStore()
        authentications = []
        expirations = []
        controller = VaultController(
            store: store,
            makeAuthentication: {
                let authentication = Authentication()
                self.authentications.append(authentication)
                return authentication
            },
            control: control.submit, worker: worker.submit,
            clock: { self.time }, scheduleExpiry: { _, action in self.expirations.append(action) })
        controller.setForeground(true)
    }

    private func request() -> String {
        requestNumber += 1
        return "request-\(requestNumber)"
    }

    private func open() throws -> String {
        let result = Outcome()
        controller.authenticate(requestId: request(), reason: "Unlock", completion: result.receive)
        authentications.last!.finish()
        control.run()
        return try XCTUnwrap(result.result?.get())
    }

    func testOnePromptPerScopeAndFIFOOperations() throws {
        let access = try open()
        let write = Outcome()
        let read = Outcome()
        controller.set(accessId: access, id: "pin", value: "1234", requestId: request(), completion: write.receive)
        controller.get(accessId: access, id: "pin", requestId: request(), completion: read.receive)
        XCTAssertEqual(worker.actions.count, 1)
        worker.run()
        control.run()
        worker.run()
        control.run()
        XCTAssertEqual(try read.result?.get(), "1234")
        XCTAssertEqual(authentications.count, 1)
        XCTAssertEqual(store.operations, ["set", "get"])
        _ = try open()
        XCTAssertEqual(authentications.count, 2)
    }

    func testExpiryChecksQueuedOperationsWithoutRenewingDeadline() throws {
        let access = try open()
        let result = Outcome()
        controller.set(accessId: access, id: "pin", value: "secret", requestId: request(), completion: result.receive)
        time = 60
        worker.run()
        control.run()
        XCTAssertEqual(result.code, "AUTHORIZATION_EXPIRED")
        XCTAssertTrue(store.values.isEmpty)
        XCTAssertTrue(authentications[0].invalidated)
    }

    func testExpiryDiscardsPlaintextAfterWorkerReadBeforeDelivery() throws {
        let access = try open()
        store.values["pin"] = "secret"
        let result = Outcome()
        controller.get(accessId: access, id: "pin", requestId: request(), completion: result.receive)
        worker.run()
        time = 60
        control.run()
        XCTAssertEqual(result.code, "AUTHORIZATION_EXPIRED")
    }

    func testExpiryActivelyInvalidatesIdleContext() throws {
        let access = try open()
        time = 60
        expirations[0]()
        XCTAssertTrue(authentications[0].invalidated)
        let result = Outcome()
        controller.get(accessId: access, id: "pin", requestId: request(), completion: result.receive)
        XCTAssertEqual(result.code, "AUTHORIZATION_EXPIRED")
    }

    func testDisposalWaitsForActiveReadAndDiscardsItsPlaintext() throws {
        let access = try open()
        store.values["pin"] = "secret"
        let read = Outcome()
        let close = Outcome()
        controller.get(accessId: access, id: "pin", requestId: request(), completion: read.receive)
        worker.run()
        controller.closeAccess(access, completion: close.receive)
        XCTAssertNil(close.result)
        control.run()
        XCTAssertEqual(read.code, "ACCESS_CLOSED")
        XCTAssertNotNil(close.result)
        XCTAssertTrue(authentications[0].invalidated)
    }

    func testDisposalCancelsActiveAndQueuedUncommittedWrites() throws {
        let access = try open()
        let first = Outcome()
        let second = Outcome()
        controller.set(accessId: access, id: "one", value: "a", requestId: request(), completion: first.receive)
        controller.set(accessId: access, id: "two", value: "b", requestId: request(), completion: second.receive)
        controller.closeAccess(access) { _ in }
        XCTAssertEqual(second.code, "ACCESS_CLOSED")
        worker.run()
        control.run()
        XCTAssertEqual(first.code, "ACCESS_CLOSED")
        XCTAssertTrue(store.values.isEmpty)
    }

    func testCommittedWriteRemainsSuccessfulAfterDisposal() throws {
        let access = try open()
        let result = Outcome()
        controller.set(accessId: access, id: "pin", value: "secret", requestId: request(), completion: result.receive)
        worker.run()
        controller.closeAccess(access) { _ in }
        control.run()
        XCTAssertNil(result.code)
        XCTAssertNotNil(result.result)
        XCTAssertEqual(store.values["pin"], "secret")
    }

    func testBackgroundRevokesScopeAndDropsInFlightRead() throws {
        let access = try open()
        let result = Outcome()
        controller.get(accessId: access, id: "pin", requestId: request(), completion: result.receive)
        worker.run()
        controller.setForeground(false)
        control.run()
        XCTAssertEqual(result.code, "APP_INACTIVE")
        XCTAssertTrue(authentications[0].invalidated)
        controller.setForeground(true)
        let later = Outcome()
        controller.get(accessId: access, id: "pin", requestId: request(), completion: later.receive)
        XCTAssertEqual(later.code, "ACCESS_CLOSED")
    }

    func testBackgroundCancelsAuthenticationWithoutPublishingAccess() {
        let result = Outcome()
        controller.authenticate(requestId: request(), reason: "Unlock", completion: result.receive)
        controller.setForeground(false)
        control.run()
        XCTAssertEqual(result.code, "APP_INACTIVE")
        XCTAssertTrue(authentications[0].invalidated)
    }

    func testCancellationWaitsForPromptTerminationBeforeNextPrompt() {
        let first = Outcome()
        let firstId = request()
        controller.authenticate(requestId: firstId, reason: "First", completion: first.receive)
        controller.authenticate(requestId: request(), reason: "Second") { _ in }
        controller.cancel(requestId: firstId)
        XCTAssertEqual(authentications.count, 1)
        control.run()
        XCTAssertEqual(first.code, "CANCELLED")
        XCTAssertEqual(authentications.count, 2)
    }

    func testCancellationBeforeEnqueueAndDuplicateIdsCannotAuthenticate() {
        controller.cancel(requestId: "cancelled")
        let result = Outcome()
        controller.authenticate(requestId: "cancelled", reason: "Unlock", completion: result.receive)
        XCTAssertEqual(result.code, "CANCELLED")
        XCTAssertTrue(authentications.isEmpty)
    }

    func testFailedWritePreservesValueAndDoesNotStrandQueue() throws {
        let access = try open()
        store.values["pin"] = "previous"
        store.writeError = .storage
        let write = Outcome()
        let read = Outcome()
        controller.set(
            accessId: access, id: "pin", value: "replacement", requestId: request(), completion: write.receive)
        controller.get(accessId: access, id: "pin", requestId: request(), completion: read.receive)
        worker.run()
        control.run()
        worker.run()
        control.run()
        XCTAssertEqual(write.code, "IO_ERROR")
        XCTAssertEqual(try read.result?.get(), "previous")
    }

    func testUnscopedRemoveAndClearDoNotAuthenticate() {
        store.values = ["one": "a", "two": "b"]
        controller.remove(accessId: nil, id: "one", requestId: nil) { _ in }
        worker.run()
        control.run()
        XCTAssertNil(store.values["one"])
        controller.clear { _ in }
        worker.run()
        control.run()
        XCTAssertTrue(store.values.isEmpty)
        XCTAssertTrue(authentications.isEmpty)
    }
}

private final class ManualQueue {
    var actions: [() -> Void] = []
    func submit(_ action: @escaping () -> Void) { actions.append(action) }
    func run() {
        while !actions.isEmpty { actions.removeFirst()() }
    }
}

private final class Authentication: VaultAuthenticating {
    let context = LAContext()
    var invalidated = false
    var completion: ((VaultError?) -> Void)?
    func authenticate(reason: String, completion: @escaping (VaultError?) -> Void) { self.completion = completion }
    func finish(_ error: VaultError? = nil) {
        let callback = completion
        completion = nil
        callback?(error)
    }
    func invalidate() {
        invalidated = true
        context.invalidate()
        finish(.cancelled)
    }
}

private final class MemoryStore: VaultStoring {
    var values: [String: String] = [:]
    var operations: [String] = []
    var writeError: VaultError?
    func get(id: String, context: LAContext) throws -> String? {
        operations.append("get")
        return values[id]
    }
    func set(id: String, value: String, context: LAContext) throws {
        if let writeError { throw writeError }
        operations.append("set")
        values[id] = value
    }
    func remove(id: String) throws { values.removeValue(forKey: id) }
    func clear() throws { values.removeAll() }
}

private final class Outcome {
    var result: Result<String?, VaultError>?
    var code: String? {
        if case .failure(let error) = result { return error.code }
        return nil
    }
    func receive(_ result: Result<String?, VaultError>) { self.result = result }
}
