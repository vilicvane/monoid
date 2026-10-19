import CoreNFC
import Foundation
import XCTest
@testable import IsoDepNfcPlugin

private final class Recorded<T> {
    var values: [Result<T, NFCFailure>] = []
    func complete(_ value: Result<T, NFCFailure>) { values.append(value) }
    var code: String? {
        guard case .failure(let failure)? = values.last else { return nil }
        return failure.code
    }
    var outcome: String? {
        guard case .failure(let failure)? = values.last else { return nil }
        return failure.outcome
    }
    var succeeded: Bool {
        guard case .success? = values.last else { return false }
        return true
    }
}

private final class FakeCard: NFCCard {
    let identifier: [UInt8] = [1, 2, 3]
    var isAvailable = true
    var sent: [[UInt8]] = []
    var completions: [(Result<[UInt8], NFCFailure>) -> Void] = []

    func transceive(_ bytes: [UInt8], completion: @escaping (Result<[UInt8], NFCFailure>) -> Void) {
        sent.append(bytes)
        completions.append(completion)
    }
}

private final class FakeReader: NFCScanDriver {
    weak var events: NFCScanEvents?
    var alertMessage = ""
    var isReady = true
    var begun = 0
    var restarts = 0
    var invalidations = 0
    var invalidationMessages: [String?] = []
    var connections: [(NFCFailure?) -> Void] = []

    func begin() { begun += 1 }
    func connect(_ card: NFCCard, completion: @escaping (NFCFailure?) -> Void) { connections.append(completion) }
    func restartPolling() { restarts += 1 }
    func invalidate(errorMessage: String?) { invalidations += 1; invalidationMessages.append(errorMessage); isReady = false }
    func activate() { events?.activated(self) }
    func discover(_ card: NFCCard) { events?.detected(self, card: card) }
    func invalidateCallback(code: String = "CANCELLED") {
        isReady = false
        events?.invalidated(self, failure: NFCFailure(code: code, message: "Test failure"))
    }
}

private final class Fixture {
    struct Task {
        let time: Int
        var cancelled = false
        let action: () -> Void
    }

    var tasks: [Int: Task] = [:]
    var clock = 0
    var nextTaskId = 0
    var events: [(String, [String: Any])] = []
    lazy var controller = NFCSessionController(schedule: { [unowned self] delay, action in
        nextTaskId += 1
        let id = nextTaskId
        tasks[id] = Task(time: clock + delay, action: action)
        return { [weak self] in self?.tasks[id]?.cancelled = true }
    }, emit: { [unowned self] name, data in events.append((name, data)) })
    let reader = FakeReader()
    let card = FakeCard()

    @discardableResult func start(_ id: String = "scan") -> Recorded<Void> {
        let result = Recorded<Void>()
        controller.start(id: id, timeoutMs: 10_000, reader: reader, completion: result.complete)
        return result
    }

    @discardableResult func open() -> String {
        start()
        reader.activate()
        reader.discover(card)
        reader.connections[0](nil)
        return events.first { $0.0 == "sessionOpened" }!.1["sessionId"] as! String
    }

    @discardableResult func exchange(_ id: String, timeout: Int? = nil) -> Recorded<[UInt8]> {
        let result = Recorded<[UInt8]>()
        controller.transceive(id: id, bytes: [0, 0xA4, 4, 0], timeoutMs: timeout, completion: result.complete)
        return result
    }

    @discardableResult func close(_ id: String, wait: Bool = false, message: String? = nil) -> Recorded<Void> {
        let result = Recorded<Void>()
        controller.close(id: id, waitForRemoval: wait, message: message, completion: result.complete)
        return result
    }

    @discardableResult func stop(_ id: String = "scan") -> Recorded<Void> {
        let result = Recorded<Void>()
        controller.stop(id: id, completion: result.complete)
        return result
    }

    func advance(_ milliseconds: Int) {
        clock += milliseconds
        while let next = tasks.filter({ !$0.value.cancelled && $0.value.time <= clock }).min(by: { $0.value.time < $1.value.time }) {
            tasks.removeValue(forKey: next.key)
            next.value.action()
        }
    }

    func count(_ event: String) -> Int { events.filter { $0.0 == event }.count }
    func reason(_ event: String) -> String? { events.last { $0.0 == event }?.1["reason"] as? String }
}

final class NFCSessionTests: XCTestCase {
    func testStartWaitsForActivationAndRejectsCompetingScan() {
        let fixture = Fixture()
        let starting = fixture.start()
        XCTAssertTrue(starting.values.isEmpty)
        XCTAssertEqual(fixture.start("other").code, "BUSY")
        XCTAssertEqual(fixture.reader.begun, 1)
        fixture.reader.activate()
        XCTAssertTrue(starting.succeeded)
    }

    func testStoppedUnknownScanIdCannotStartLater() {
        let fixture = Fixture()
        XCTAssertTrue(fixture.stop("stale").succeeded)
        XCTAssertEqual(fixture.start("stale").code, "SCAN_CLOSED")
        XCTAssertEqual(fixture.reader.begun, 0)
    }

    func testClosingResumesDiscoveryWithoutEndingScan() {
        let fixture = Fixture()
        let id = fixture.open()
        fixture.reader.discover(FakeCard())
        XCTAssertEqual(fixture.reader.connections.count, 1)
        XCTAssertFalse(fixture.controller.canDiscover(fixture.reader))
        XCTAssertTrue(fixture.close(id).succeeded)
        XCTAssertEqual(fixture.count("sessionEnded"), 1)
        XCTAssertEqual(fixture.reason("sessionEnded"), "closed")
        XCTAssertEqual(fixture.reader.restarts, 1)
        XCTAssertTrue(fixture.controller.canDiscover(fixture.reader))
        XCTAssertEqual(fixture.count("scanEnded"), 0)
        XCTAssertTrue(fixture.close(id).succeeded)
        XCTAssertEqual(fixture.close(id, wait: true).code, "SESSION_CLOSED")
    }

    func testConcurrentApduIsRejectedAndNeverQueued() {
        let fixture = Fixture()
        let id = fixture.open()
        let first = fixture.exchange(id)
        let second = fixture.exchange(id)
        XCTAssertEqual(second.code, "BUSY")
        XCTAssertEqual(second.outcome, "not-sent")
        XCTAssertEqual(fixture.card.sent.count, 1)
        fixture.card.completions[0](.success([0x11, 0x61, 0x02]))
        guard case .success(let data)? = first.values.last else { return XCTFail("Missing response") }
        XCTAssertEqual(data, [0x11, 0x61, 0x02])
        XCTAssertEqual(fixture.card.sent.count, 1)
    }

    func testSessionCleanupPreservesProgressThroughScanDismissal() throws {
        let fixture = Fixture()
        let id = fixture.open()
        let exchange = fixture.exchange(id)
        fixture.card.completions[0](.success([0x90, 0]))
        XCTAssertTrue(exchange.succeeded)
        let message = "Reading card…\n4 of 4 records"
        try fixture.controller.setSessionMessage(id: id, message: message)

        XCTAssertTrue(fixture.close(id).succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, message)
        XCTAssertEqual(fixture.reader.restarts, 1)
        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: id, message: "Late progress"))
        let stopped = fixture.stop()
        XCTAssertEqual(fixture.reader.alertMessage, message)
        XCTAssertEqual(fixture.reader.invalidationMessages, [nil])
        XCTAssertTrue(stopped.values.isEmpty)
        fixture.reader.invalidateCallback()
        XCTAssertTrue(stopped.succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, message)
        XCTAssertEqual(fixture.card.sent.count, 1)
    }

    func testSessionMessageUpdatesDoNotSendCommandsOrExtendExchangeDeadline() throws {
        let fixture = Fixture()
        let id = fixture.open()
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        XCTAssertTrue(fixture.card.sent.isEmpty)

        let exchange = fixture.exchange(id, timeout: 500)
        fixture.advance(250)
        let scheduled = fixture.nextTaskId
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…\n2 of 4 records")
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…\n2 of 4 records")
        XCTAssertEqual(fixture.nextTaskId, scheduled)
        XCTAssertEqual(fixture.reader.restarts, 0)
        XCTAssertEqual(fixture.reader.invalidations, 0)
        XCTAssertEqual(fixture.card.sent.count, 1)
        XCTAssertEqual(fixture.count("sessionEnded"), 0)

        fixture.advance(250)
        XCTAssertEqual(exchange.code, "TIMEOUT")
        XCTAssertEqual(exchange.outcome, "unknown")
        XCTAssertEqual(fixture.card.sent.count, 1)
    }

    func testEmptyCloseMessageClearsProgressAndSurvivesScanDismissal() throws {
        let fixture = Fixture()
        let id = fixture.open()
        let exchange = fixture.exchange(id)
        fixture.card.completions[0](.success([0x90, 0]))
        XCTAssertTrue(exchange.succeeded)
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
        let scheduled = fixture.nextTaskId

        XCTAssertTrue(fixture.close(id, message: "").succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "")
        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: id, message: "Late progress")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }
        let stopped = fixture.stop()
        XCTAssertEqual(fixture.reader.alertMessage, "")
        XCTAssertEqual(fixture.reader.invalidationMessages, [nil])
        XCTAssertTrue(stopped.values.isEmpty)
        fixture.reader.invalidateCallback()
        XCTAssertTrue(stopped.succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "")
        XCTAssertEqual(fixture.nextTaskId, scheduled)
        XCTAssertEqual(fixture.card.sent.count, 1)
    }

    func testCloseMessageIsIdempotentAndCannotChangeAnotherConnection() throws {
        let fixture = Fixture()
        let oldId = fixture.open()
        XCTAssertTrue(fixture.close(oldId, message: "").succeeded)
        XCTAssertTrue(fixture.close(oldId, message: "Repeated close").succeeded)
        XCTAssertTrue(fixture.close("unknown", message: "Unknown close").succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "")

        let nextCard = FakeCard()
        fixture.reader.discover(nextCard)
        fixture.reader.connections[1](nil)
        let newId = fixture.events.last { $0.0 == "sessionOpened" }!.1["sessionId"] as! String
        try fixture.controller.setSessionMessage(id: newId, message: "Current connection")
        for id in [oldId, "unknown"] {
            XCTAssertTrue(fixture.close(id, message: "").succeeded)
            XCTAssertEqual(fixture.reader.alertMessage, "Current connection")
        }
        XCTAssertTrue(fixture.exchange(newId).values.isEmpty)
        XCTAssertEqual(nextCard.sent.count, 1)
        XCTAssertEqual(fixture.reader.restarts, 1)
    }

    func testCloseMessageCannotCompleteAnInflightExchange() throws {
        let fixture = Fixture()
        let id = fixture.open()
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
        let exchange = fixture.exchange(id)
        let closed = fixture.close(id, message: "")

        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        XCTAssertEqual(exchange.code, "CANCELLED")
        XCTAssertEqual(exchange.outcome, "unknown")
        XCTAssertTrue(closed.values.isEmpty)
        XCTAssertEqual(fixture.reader.invalidations, 1)
        XCTAssertEqual(fixture.reader.restarts, 0)
        fixture.reader.invalidateCallback()
        XCTAssertTrue(closed.succeeded)
        fixture.card.completions[0](.success([0x90, 0]))
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        XCTAssertEqual(fixture.card.sent.count, 1)
    }

    func testCloseMessageCannotCompleteFailedOrTimedOutExchanges() throws {
        for code in ["TAG_LOST", "IO_ERROR", "TIMEOUT"] {
            let fixture = Fixture()
            let id = fixture.open()
            try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
            let exchange = fixture.exchange(id, timeout: 500)
            if code == "TIMEOUT" {
                fixture.advance(500)
            } else {
                fixture.card.completions[0](.failure(NFCFailure(code: code, message: "Failed")))
            }
            let closed = fixture.close(id, message: "")

            XCTAssertEqual(exchange.code, code)
            XCTAssertEqual(exchange.outcome, "unknown")
            XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
            fixture.stop()
            XCTAssertEqual(fixture.reader.invalidationMessages, [code == "TAG_LOST" ? "Card connection lost." : nil])
            fixture.reader.invalidateCallback()
            XCTAssertTrue(closed.succeeded)
            XCTAssertEqual(fixture.card.sent.count, 1)
        }
    }

    func testCloseMessageCannotCompleteFailedOrTimedOutConnections() {
        for timesOut in [false, true] {
            let fixture = Fixture()
            fixture.start()
            fixture.reader.activate()
            fixture.reader.alertMessage = "Hold your card near the top of your iPhone."
            fixture.reader.discover(fixture.card)
            if timesOut {
                fixture.advance(30_000)
            } else {
                fixture.reader.connections[0](NFCFailure(code: "IO_ERROR", message: "Failed"))
            }
            let id = fixture.events.first { $0.0 == "sessionEnded" }!.1["sessionId"] as! String
            let closed = fixture.close(id, message: "")

            XCTAssertEqual(fixture.reader.alertMessage, "Hold your card near the top of your iPhone.")
            XCTAssertEqual(fixture.count("sessionOpened"), 0)
            fixture.stop()
            fixture.reader.invalidateCallback()
            XCTAssertTrue(closed.succeeded)
            XCTAssertTrue(fixture.card.sent.isEmpty)
        }
    }

    func testCloseMessageCannotReplaceRemovalInstructions() {
        let fixture = Fixture()
        let id = fixture.open()
        let removing = fixture.close(id, wait: true, message: "")
        XCTAssertEqual(fixture.reader.alertMessage, "Remove the card before scanning it again.")
        XCTAssertTrue(fixture.close(id, message: "").succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "Remove the card before scanning it again.")
        XCTAssertTrue(removing.values.isEmpty)
        XCTAssertEqual(fixture.reader.restarts, 0)
        fixture.card.isAvailable = false
        fixture.advance(250)
        XCTAssertTrue(removing.succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "Hold your card near the top of your iPhone.")
        XCTAssertTrue(fixture.close(id, wait: true, message: "").succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "Hold your card near the top of your iPhone.")
        XCTAssertTrue(fixture.card.sent.isEmpty)
    }

    func testCloseMessageCannotChangeAStoppingScan() throws {
        let fixture = Fixture()
        let id = fixture.open()
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
        let stopped = fixture.stop()
        let closed = fixture.close(id, message: "")
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        XCTAssertTrue(closed.values.isEmpty)
        fixture.reader.invalidateCallback()
        XCTAssertTrue(closed.succeeded)
        XCTAssertTrue(stopped.succeeded)
        XCTAssertTrue(fixture.close(id, message: "").succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
    }

    func testSessionMessageCannotOverwriteRemovalInstructions() {
        let fixture = Fixture()
        let id = fixture.open()
        let removing = fixture.close(id, wait: true)
        let message = fixture.reader.alertMessage
        let scheduled = fixture.nextTaskId

        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: id, message: "Late progress")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }
        XCTAssertEqual(fixture.reader.alertMessage, message)
        XCTAssertEqual(fixture.nextTaskId, scheduled)
        XCTAssertEqual(fixture.reader.restarts, 0)
        XCTAssertTrue(fixture.card.sent.isEmpty)
        XCTAssertTrue(removing.values.isEmpty)

        fixture.card.isAvailable = false
        fixture.advance(250)
        XCTAssertTrue(removing.succeeded)
    }

    func testSessionMessageCannotOverwriteLostConnectionPresentation() throws {
        let fixture = Fixture()
        let id = fixture.open()
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
        let exchange = fixture.exchange(id)
        fixture.card.completions[0](.failure(NFCFailure(code: "TAG_LOST", message: "Card disconnected")))

        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: id, message: "Late progress")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        XCTAssertEqual(exchange.code, "TAG_LOST")
        XCTAssertEqual(exchange.outcome, "unknown")
        fixture.close(id)
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        fixture.stop()
        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: id, message: "Late completion")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }
        XCTAssertEqual(fixture.reader.invalidationMessages, ["Card connection lost."])
        XCTAssertEqual(fixture.card.sent.count, 1)
    }

    func testSessionMessageRejectsUnknownClosedAndPreviousConnectionIds() throws {
        let fixture = Fixture()
        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: "unknown", message: "Progress")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }

        let oldId = fixture.open()
        fixture.close(oldId)
        fixture.reader.discover(FakeCard())
        fixture.reader.connections[1](nil)
        let newId = fixture.events.last { $0.0 == "sessionOpened" }!.1["sessionId"] as! String
        try fixture.controller.setSessionMessage(id: newId, message: "Current connection")

        for id in ["unknown", oldId] {
            XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: id, message: "Stale progress")) { error in
                XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
            }
            XCTAssertEqual(fixture.reader.alertMessage, "Current connection")
        }

        fixture.stop()
        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: newId, message: "Stopping")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }
        fixture.reader.invalidateCallback()
        XCTAssertThrowsError(try fixture.controller.setSessionMessage(id: newId, message: "Closed")) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "SESSION_CLOSED")
        }
        XCTAssertEqual(fixture.reader.alertMessage, "Current connection")
    }

    func testSessionMessageValidationRequiresTextAndPreservesFormatting() throws {
        XCTAssertThrowsError(try NFCArguments.message([:])) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "INVALID_ARGUMENT")
        }
        for invalid: Any in ["", " \n\t", NSNull(), true, 123, ["Reading"]] {
            XCTAssertThrowsError(try NFCArguments.message(["message": invalid])) { error in
                XCTAssertEqual((error as? NFCFailure)?.code, "INVALID_ARGUMENT")
            }
        }
        let message = "  Reading card…\nKeep the card in place.  "
        XCTAssertEqual(try NFCArguments.message(["message": message]), message)
    }

    func testCloseMessageValidationAllowsEmptyWithoutRelaxingOtherValues() throws {
        XCTAssertEqual(try NFCArguments.message(["message": ""], allowEmpty: true), "")
        let message = "  Completed.  "
        XCTAssertEqual(try NFCArguments.message(["message": message], allowEmpty: true), message)
        XCTAssertThrowsError(try NFCArguments.message([:], allowEmpty: true)) { error in
            XCTAssertEqual((error as? NFCFailure)?.code, "INVALID_ARGUMENT")
        }
        for invalid: Any in [" \n\t", NSNull(), true, 123, ["Completed."]] {
            XCTAssertThrowsError(try NFCArguments.message(["message": invalid], allowEmpty: true)) { error in
                XCTAssertEqual((error as? NFCFailure)?.code, "INVALID_ARGUMENT")
            }
        }
    }

    func testMalformedApduDoesNotEndConnectionOrConsumeTimeout() {
        let fixture = Fixture()
        let id = fixture.open()
        let result = fixture.exchange(id)
        fixture.card.completions[0](.failure(NFCFailure(code: "INVALID_ARGUMENT", message: "Invalid APDU", outcome: "not-sent")))
        XCTAssertEqual(result.outcome, "not-sent")
        fixture.advance(20_000)
        XCTAssertEqual(fixture.count("sessionEnded"), 0)
        fixture.exchange(id)
        XCTAssertEqual(fixture.card.sent.count, 2)
    }

    func testTimeoutInvalidatesReaderAndIgnoresLateApdu() {
        let fixture = Fixture()
        let id = fixture.open()
        let result = fixture.exchange(id, timeout: 500)
        fixture.advance(500)
        XCTAssertEqual(result.code, "TIMEOUT")
        XCTAssertEqual(result.outcome, "unknown")
        XCTAssertEqual(fixture.reason("sessionEnded"), "transceive-timeout")
        XCTAssertEqual(fixture.reason("scanEnded"), "timeout")
        XCTAssertEqual(fixture.reader.invalidations, 1)
        let stopped = fixture.stop()
        XCTAssertTrue(stopped.values.isEmpty)
        XCTAssertEqual(fixture.start("next").code, "BUSY")
        fixture.reader.invalidateCallback()
        XCTAssertTrue(stopped.succeeded)
        fixture.card.completions[0](.success([0x90, 0]))
        XCTAssertEqual(result.values.count, 1)
        XCTAssertEqual(fixture.count("scanEnded"), 1)
    }

    func testStopCancelsInflightApduAndWaitsForInvalidation() {
        let fixture = Fixture()
        let id = fixture.open()
        let exchange = fixture.exchange(id)
        let stopped = fixture.stop()
        XCTAssertEqual(exchange.code, "CANCELLED")
        XCTAssertEqual(exchange.outcome, "unknown")
        XCTAssertEqual(fixture.reason("sessionEnded"), "scan-stopped")
        XCTAssertTrue(stopped.values.isEmpty)
        fixture.reader.invalidateCallback()
        XCTAssertTrue(stopped.succeeded)
        XCTAssertEqual(fixture.start().code, "SCAN_CLOSED")
    }

    func testCloseDuringExchangeEndsWholeReader() {
        let fixture = Fixture()
        let id = fixture.open()
        fixture.exchange(id)
        let closed = fixture.close(id)
        XCTAssertTrue(closed.values.isEmpty)
        XCTAssertEqual(fixture.reader.invalidations, 1)
        XCTAssertEqual(fixture.reader.restarts, 0)
        fixture.reader.invalidateCallback()
        XCTAssertTrue(closed.succeeded)
    }

    func testRemovalGateNeverSendsAnApduAndResolvesAllWaiters() {
        let fixture = Fixture()
        let id = fixture.open()
        let first = fixture.close(id, wait: true)
        let second = fixture.close(id, wait: true)
        fixture.advance(1_000)
        XCTAssertTrue(first.values.isEmpty)
        XCTAssertTrue(second.values.isEmpty)
        XCTAssertTrue(fixture.card.sent.isEmpty)
        XCTAssertEqual(fixture.reader.restarts, 0)
        XCTAssertFalse(fixture.controller.canDiscover(fixture.reader))
        XCTAssertEqual(fixture.reader.alertMessage, "Remove the card before scanning it again.")
        fixture.card.isAvailable = false
        fixture.advance(250)
        XCTAssertTrue(first.succeeded)
        XCTAssertTrue(second.succeeded)
        XCTAssertEqual(fixture.reader.restarts, 1)
        XCTAssertEqual(fixture.reader.alertMessage, "Hold your card near the top of your iPhone.")
        XCTAssertTrue(fixture.close(id, wait: true).succeeded)
    }

    func testStopRejectsRemovalWaitRatherThanReportingRemoval() {
        let fixture = Fixture()
        let id = fixture.open()
        let waiting = fixture.close(id, wait: true)
        fixture.stop()
        fixture.card.isAvailable = false
        fixture.advance(1_000)
        XCTAssertTrue(waiting.values.isEmpty)
        fixture.reader.invalidateCallback()
        XCTAssertEqual(waiting.code, "CANCELLED")
        XCTAssertEqual(fixture.reader.restarts, 0)
    }

    func testInvalidReaderAvailabilityIsNotCardRemoval() {
        let fixture = Fixture()
        let id = fixture.open()
        let waiting = fixture.close(id, wait: true)
        fixture.reader.isReady = false
        fixture.card.isAvailable = false
        fixture.advance(250)
        XCTAssertTrue(waiting.values.isEmpty)
        fixture.reader.invalidateCallback(code: "TIMEOUT")
        XCTAssertEqual(waiting.code, "TIMEOUT")
        XCTAssertEqual(fixture.reader.restarts, 0)
    }

    func testTagLostCanImmediatelyReleaseRemovalGate() {
        let fixture = Fixture()
        let id = fixture.open()
        let exchange = fixture.exchange(id)
        fixture.card.completions[0](.failure(NFCFailure(code: "TAG_LOST", message: "Lost")))
        XCTAssertEqual(exchange.outcome, "unknown")
        XCTAssertFalse(fixture.controller.canDiscover(fixture.reader))
        XCTAssertTrue(fixture.close(id, wait: true).succeeded)
        XCTAssertEqual(fixture.reader.restarts, 1)
    }

    func testUnavailableCardResponseFailureEndsExchangeWithoutRetryOrKnownOutcome() {
        let fixture = Fixture()
        let id = fixture.open()
        let exchange = fixture.exchange(id)
        fixture.card.isAvailable = false
        let error = NSError(domain: NFCErrorDomain, code: NFCReaderError.Code.readerTransceiveErrorTagResponseError.rawValue)
        fixture.card.completions[0](.failure(CoreNFCReader.transceiveFailure(error, tagAvailable: fixture.card.isAvailable, readerReady: fixture.reader.isReady)))

        XCTAssertEqual(exchange.code, "TAG_LOST")
        XCTAssertEqual(exchange.outcome, "unknown")
        XCTAssertEqual(fixture.reason("sessionEnded"), "tag-lost")
        XCTAssertEqual(fixture.count("sessionEnded"), 1)
        XCTAssertEqual(fixture.card.sent.count, 1)
        XCTAssertEqual(fixture.exchange(id).code, "SESSION_CLOSED")
        XCTAssertEqual(fixture.card.sent.count, 1)

        let stopped = fixture.stop()
        XCTAssertTrue(stopped.values.isEmpty)
        fixture.reader.invalidateCallback()
        fixture.card.completions[0](.success([0x90, 0]))
        XCTAssertTrue(stopped.succeeded)
        XCTAssertEqual(exchange.values.count, 1)
        XCTAssertEqual(fixture.count("sessionEnded"), 1)
        XCTAssertEqual(fixture.reader.restarts, 0)
    }

    func testTagLossSystemMessageSurvivesSessionCleanup() {
        for cleanup in [nil, false, true] as [Bool?] {
            let fixture = Fixture()
            let id = fixture.open()
            let exchange = fixture.exchange(id)
            fixture.card.completions[0](.failure(NFCFailure(code: "TAG_LOST", message: "Lost")))
            if let cleanup {
                XCTAssertTrue(fixture.close(id, wait: cleanup).succeeded)
            }

            let stopped = fixture.stop()
            let stoppedAgain = fixture.stop()
            XCTAssertEqual(fixture.reader.invalidationMessages, ["Card connection lost."])
            XCTAssertEqual(fixture.reader.invalidations, 1)
            XCTAssertEqual(exchange.outcome, "unknown")
            XCTAssertTrue(stopped.values.isEmpty)
            fixture.reader.invalidateCallback()
            XCTAssertTrue(stopped.succeeded)
            XCTAssertTrue(stoppedAgain.succeeded)
            XCTAssertEqual(fixture.count("sessionEnded"), 1)
            XCTAssertEqual(fixture.reason("sessionEnded"), "tag-lost")
            XCTAssertEqual(fixture.card.sent.count, 1)
        }
    }

    func testSuccessfulExchangeAndRemovalKeepNormalSystemDismissal() {
        for waitForRemoval in [false, true] {
            let fixture = Fixture()
            let id = fixture.open()
            XCTAssertTrue(fixture.exchange(id).values.isEmpty)
            fixture.card.completions[0](.success([0x90, 0]))
            let closed = fixture.close(id, wait: waitForRemoval)
            if waitForRemoval {
                fixture.card.isAvailable = false
                fixture.advance(250)
            }
            XCTAssertTrue(closed.succeeded)
            fixture.stop()
            XCTAssertEqual(fixture.reader.invalidationMessages, [nil])
        }
    }

    func testRediscoveryCannotEraseTagLossMessageBeforeStop() throws {
        let fixture = Fixture()
        let id = fixture.open()
        try fixture.controller.setSessionMessage(id: id, message: "Reading card…")
        fixture.exchange(id)
        fixture.card.completions[0](.failure(NFCFailure(code: "TAG_LOST", message: "Lost")))
        fixture.close(id)

        let nextCard = FakeCard()
        fixture.reader.discover(nextCard)
        fixture.reader.connections[1](nil)
        let newId = fixture.events.last { $0.0 == "sessionOpened" }!.1["sessionId"] as! String
        XCTAssertTrue(fixture.close(newId, message: "").succeeded)
        XCTAssertEqual(fixture.reader.alertMessage, "Reading card…")
        fixture.stop()
        XCTAssertEqual(fixture.reader.invalidationMessages, ["Card connection lost."])
        XCTAssertTrue(nextCard.sent.isEmpty)
    }

    func testNewScanDoesNotInheritPreviousTagLossMessage() {
        let fixture = Fixture()
        let id = fixture.open()
        fixture.exchange(id)
        fixture.card.completions[0](.failure(NFCFailure(code: "TAG_LOST", message: "Lost")))
        fixture.stop()
        fixture.reader.invalidateCallback()

        let nextReader = FakeReader()
        let starting = Recorded<Void>()
        fixture.controller.start(id: "next", timeoutMs: 10_000, reader: nextReader, completion: starting.complete)
        nextReader.activate()
        XCTAssertTrue(starting.succeeded)
        fixture.stop("next")
        XCTAssertEqual(nextReader.invalidationMessages, [nil])
    }

    func testTagLossDoesNotChangeSubsequentLifecycleDismissal() {
        for (reason, code) in [("app-paused", "APP_INACTIVE"), ("timeout", "TIMEOUT")] {
            let fixture = Fixture()
            let id = fixture.open()
            fixture.exchange(id)
            fixture.card.completions[0](.failure(NFCFailure(code: "TAG_LOST", message: "Lost")))
            fixture.close(id)
            fixture.controller.terminate(reason: reason, code: code)
            XCTAssertEqual(fixture.reader.invalidationMessages, [nil])
            XCTAssertEqual(fixture.reason("scanEnded"), reason)
        }
    }

    func testConnectionErrorStaysReservedUntilExplicitCleanup() {
        let fixture = Fixture()
        fixture.start()
        fixture.reader.activate()
        fixture.reader.discover(fixture.card)
        fixture.reader.connections[0](NFCFailure(code: "IO_ERROR", message: "Failed"))
        XCTAssertEqual(fixture.count("sessionOpened"), 0)
        XCTAssertEqual(fixture.count("sessionEnded"), 1)
        XCTAssertFalse(fixture.controller.canDiscover(fixture.reader))
        let id = fixture.events.last!.1["sessionId"] as! String
        XCTAssertEqual(fixture.close(id, wait: true).code, "UNSUPPORTED")
        XCTAssertEqual(fixture.reader.invalidations, 1)
        XCTAssertEqual(fixture.reader.restarts, 0)
    }

    func testConnectionTimeoutRejectsLateSuccessfulConnect() {
        let fixture = Fixture()
        fixture.start()
        fixture.reader.activate()
        fixture.reader.discover(fixture.card)
        fixture.advance(30_000)
        XCTAssertEqual(fixture.reason("sessionEnded"), "connect-timeout")
        fixture.reader.connections[0](nil)
        XCTAssertEqual(fixture.count("sessionOpened"), 0)
        XCTAssertEqual(fixture.reader.invalidations, 1)
    }

    func testUserCancelAndTimeoutAreDistinctScanFailures() {
        for (code, reason) in [("CANCELLED", "cancelled"), ("TIMEOUT", "timeout")] {
            let fixture = Fixture()
            fixture.open()
            fixture.reader.invalidateCallback(code: code)
            XCTAssertEqual(fixture.reason("scanEnded"), reason)
            XCTAssertEqual(fixture.events.last!.1["code"] as? String, code)
        }
    }

    func testBackgroundTerminatesReaderAndDoesNotAutoResume() {
        let fixture = Fixture()
        let id = fixture.open()
        let waiting = fixture.close(id, wait: true)
        fixture.controller.terminate(reason: "app-paused", code: "APP_INACTIVE")
        fixture.reader.invalidateCallback()
        XCTAssertEqual(waiting.code, "APP_INACTIVE")
        XCTAssertEqual(fixture.reason("scanEnded"), "app-paused")
        XCTAssertEqual(fixture.reader.begun, 1)
    }

    func testOldCallbacksCannotAffectNewScan() {
        let fixture = Fixture()
        fixture.start()
        fixture.reader.activate()
        fixture.reader.discover(fixture.card)
        fixture.stop()
        fixture.reader.invalidateCallback()
        let newReader = FakeReader()
        let starting = Recorded<Void>()
        fixture.controller.start(id: "new", timeoutMs: 10_000, reader: newReader, completion: starting.complete)
        newReader.activate()
        fixture.reader.connections[0](nil)
        fixture.controller.invalidated(fixture.reader, failure: NFCFailure(code: "TIMEOUT", message: "Late"))
        XCTAssertTrue(starting.succeeded)
        XCTAssertTrue(fixture.controller.canDiscover(newReader))
        XCTAssertEqual(newReader.invalidations, 0)
        XCTAssertEqual(fixture.count("sessionOpened"), 0)
    }

    func testArgumentValidationRejectsBooleanNumbersAndFractionalBytes() throws {
        for invalid: Any in [true, false, 0, -1, 1.5, Double.infinity, Int64(Int32.max) + 1, NSNull(), "100"] {
            XCTAssertThrowsError(try NFCArguments.timeout(["timeout": invalid], key: "timeout"))
        }
        XCTAssertEqual(try NFCArguments.timeout(["timeout": 240_000], key: "timeout"), 240_000)
        XCTAssertNil(try NFCArguments.timeout([:], key: "timeout"))
        for invalid: Any in [[true], [1.5], [-1], [256], [], "data", NSNull()] {
            XCTAssertThrowsError(try NFCArguments.bytes(["data": invalid]))
        }
        XCTAssertEqual(try NFCArguments.bytes(["data": [0, 128, 255]]), [0, 128, 255])
        XCTAssertThrowsError(try NFCArguments.id(["scanId": " \n"], key: "scanId"))
        XCTAssertThrowsError(try NFCArguments.waitForRemoval(["waitForRemoval": 1]))
        XCTAssertTrue(try NFCArguments.waitForRemoval(["waitForRemoval": true]))
        XCTAssertFalse(try NFCArguments.waitForRemoval([:]))
    }

}
