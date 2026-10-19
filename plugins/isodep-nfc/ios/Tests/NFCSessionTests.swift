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
    var connections: [(NFCFailure?) -> Void] = []

    func begin() { begun += 1 }
    func connect(_ card: NFCCard, completion: @escaping (NFCFailure?) -> Void) { connections.append(completion) }
    func restartPolling() { restarts += 1 }
    func invalidate() { invalidations += 1; isReady = false }
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

    @discardableResult func close(_ id: String, wait: Bool = false) -> Recorded<Void> {
        let result = Recorded<Void>()
        controller.close(id: id, waitForRemoval: wait, completion: result.complete)
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
        fixture.card.isAvailable = false
        fixture.advance(250)
        XCTAssertTrue(first.succeeded)
        XCTAssertTrue(second.succeeded)
        XCTAssertEqual(fixture.reader.restarts, 1)
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
