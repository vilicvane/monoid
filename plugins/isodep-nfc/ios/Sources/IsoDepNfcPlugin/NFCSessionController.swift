import Foundation

struct NFCFailure: Error {
    let code: String
    let message: String
    var outcome: String?
}

protocol NFCCard: AnyObject {
    var identifier: [UInt8] { get }
    var isAvailable: Bool { get }
    func transceive(_ bytes: [UInt8], completion: @escaping (Result<[UInt8], NFCFailure>) -> Void)
}

protocol NFCScanEvents: AnyObject {
    func canDiscover(_ reader: NFCScanDriver) -> Bool
    func activated(_ reader: NFCScanDriver)
    func detected(_ reader: NFCScanDriver, card: NFCCard)
    func invalidated(_ reader: NFCScanDriver, failure: NFCFailure)
}

protocol NFCScanDriver: AnyObject {
    var events: NFCScanEvents? { get set }
    var alertMessage: String { get set }
    var isReady: Bool { get }
    func begin()
    func connect(_ card: NFCCard, completion: @escaping (NFCFailure?) -> Void)
    func restartPolling()
    func invalidate(errorMessage: String?)
}

/// All methods and driver callbacks run on the main queue. Only one native APDU
/// may be in flight; a rejected second call is never queued or sent later.
final class NFCSessionController: NFCScanEvents {
    typealias Completion = (Result<Void, NFCFailure>) -> Void
    typealias Schedule = (Int, @escaping () -> Void) -> () -> Void

    private final class Scan {
        let id: String
        let timeoutMs: Int
        let reader: NFCScanDriver
        let validateStart: () -> NFCFailure?
        var starting: Completion?
        var stopping: [Completion] = []
        var endCode: String?
        var connectionLost = false
        var completedSuccessfully = false
        var stopAcknowledged = false
        var completionErrorMessage: String?
        var removedSessionId: String?
        var session: Session?

        init(id: String, timeoutMs: Int, reader: NFCScanDriver,
             validateStart: @escaping () -> NFCFailure?, starting: @escaping Completion) {
            self.id = id
            self.timeoutMs = timeoutMs
            self.reader = reader
            self.validateStart = validateStart
            self.starting = starting
        }
    }

    private final class Session {
        let id = UUID().uuidString
        let card: NFCCard
        var connected = false
        var working = true
        var ended = false
        var removed = false
        var waitingForRemoval = false
        var cancelDeadline: (() -> Void)?
        var cancelRemovalCheck: (() -> Void)?
        var exchange: ((Result<[UInt8], NFCFailure>) -> Void)?
        var closing: [Completion] = []
        var removing: [Completion] = []

        init(card: NFCCard) {
            self.card = card
        }
    }

    private var scan: Scan?
    private var pendingScan: Scan?
    private var retiredIds: Set<String> = []
    private let schedule: Schedule
    private let emit: (String, [String: Any]) -> Void

    init(schedule: @escaping Schedule, emit: @escaping (String, [String: Any]) -> Void) {
        self.schedule = schedule
        self.emit = emit
    }

    func start(id: String, timeoutMs: Int, reader: NFCScanDriver,
               validateStart: @escaping () -> NFCFailure? = { nil }, completion: @escaping Completion) {
        if retiredIds.contains(id) {
            completion(.failure(NFCFailure(code: "SCAN_CLOSED", message: "This scan ID has already ended.")))
            return
        }
        guard pendingScan == nil, scan == nil || scan?.stopAcknowledged == true else {
            completion(.failure(NFCFailure(code: "BUSY", message: "Scanning is already active or stopping.")))
            return
        }

        let next = Scan(id: id, timeoutMs: timeoutMs, reader: reader,
                        validateStart: validateStart, starting: completion)
        if scan == nil {
            begin(next)
        } else {
            pendingScan = next
        }
    }

    private func begin(_ next: Scan) {
        if let failure = next.validateStart() {
            retiredIds.insert(next.id)
            let completion = next.starting
            next.starting = nil
            completion?(.failure(failure))
            return
        }
        scan = next
        next.reader.events = self
        next.reader.begin()
    }

    func activated(_ reader: NFCScanDriver) {
        guard let scan, scan.reader === reader, scan.endCode == nil else { return }
        let completion = scan.starting
        scan.starting = nil
        completion?(.success(()))
    }

    func canDiscover(_ reader: NFCScanDriver) -> Bool {
        guard let scan else { return false }
        return scan.reader === reader && scan.endCode == nil &&
            !scan.completedSuccessfully && scan.completionErrorMessage == nil && scan.session == nil
    }

    func detected(_ reader: NFCScanDriver, card: NFCCard) {
        guard let scan, scan.reader === reader, scan.endCode == nil,
              !scan.completedSuccessfully, scan.completionErrorMessage == nil, scan.session == nil else { return }
        let session = Session(card: card)
        scan.session = session
        session.cancelDeadline = schedule(30_000) { [weak self, weak scan, weak session] in
            guard let self, let scan, let session, self.scan === scan, !session.ended else { return }
            self.endSession(scan, session, reason: "connect-timeout", code: "TIMEOUT")
            self.endScan(scan, reason: "timeout", code: "TIMEOUT")
        }
        reader.connect(card) { [weak self, weak scan, weak session] failure in
            guard let self, let scan, let session, self.scan === scan, scan.session === session else { return }
            session.working = false
            session.cancelDeadline?()
            session.cancelDeadline = nil
            guard scan.endCode == nil else { return }

            if let failure {
                self.endSession(scan, session, reason: self.reason(for: failure.code), code: failure.code)
                return
            }
            guard !session.ended else { return }

            session.connected = true
            self.emit("sessionOpened", [
                "scanId": scan.id,
                "sessionId": session.id,
                "tag": ["identifier": session.card.identifier]
            ])
        }
    }

    func transceive(id: String, bytes: [UInt8], timeoutMs: Int?, completion: @escaping (Result<[UInt8], NFCFailure>) -> Void) {
        guard let scan, scan.endCode == nil, let session = scan.session,
              session.id == id, session.connected, !session.ended else {
            completion(.failure(NFCFailure(code: "SESSION_CLOSED", message: "The NFC session is closed.", outcome: "not-sent")))
            return
        }
        guard session.exchange == nil else {
            completion(.failure(NFCFailure(code: "BUSY", message: "An NFC exchange is already in progress.", outcome: "not-sent")))
            return
        }

        session.exchange = completion
        session.working = true
        session.cancelDeadline = schedule(timeoutMs ?? scan.timeoutMs) { [weak self, weak scan, weak session] in
            guard let self, let scan, let session, self.scan === scan, !session.ended else { return }
            self.endSession(scan, session, reason: "transceive-timeout", code: "TIMEOUT")
            // Core NFC cannot cancel a single APDU. Invalidate the entire reader
            // before another connection can execute a command.
            self.endScan(scan, reason: "timeout", code: "TIMEOUT")
        }
        session.card.transceive(bytes) { [weak self, weak scan, weak session] result in
            guard let self, let scan, let session, self.scan === scan, scan.session === session else { return }
            session.working = false
            session.cancelDeadline?()
            session.cancelDeadline = nil
            guard !session.ended else { return }
            let completion = session.exchange
            session.exchange = nil

            switch result {
            case .success(let data):
                completion?(.success(data))
            case .failure(var failure):
                // A parse failure can occur before Core NFC is invoked. All
                // failures after sendCommand are uncertain, even on timeout.
                failure.outcome = failure.outcome ?? "unknown"
                completion?(.failure(failure))
                if failure.outcome != "not-sent" {
                    self.endSession(scan, session, reason: self.reason(for: failure.code), code: failure.code)
                }
            }
        }
    }

    func setSessionMessage(id: String, message: String) throws {
        guard let scan, scan.endCode == nil, let session = scan.session,
              session.id == id, session.connected, !session.ended, !session.waitingForRemoval else {
            throw NFCFailure(code: "SESSION_CLOSED", message: "The NFC session is closed.")
        }
        scan.reader.alertMessage = message
    }

    func close(id: String, waitForRemoval: Bool, message: String? = nil,
               errorMessage: String? = nil, completion: @escaping Completion) {
        guard let scan, let session = scan.session, session.id == id else {
            if waitForRemoval && (scan == nil || scan?.removedSessionId != id) {
                completion(.failure(NFCFailure(code: "SESSION_CLOSED", message: "This NFC session is no longer available.")))
            } else {
                completion(.success(()))
            }
            return
        }

        // Final application results reserve discovery for stopScan. Only an
        // explicit success can finish before the system sheet disappears;
        // application failures keep the native cleanup barrier.
        if scan.endCode == nil, !scan.connectionLost, scan.completionErrorMessage == nil,
           session.connected, !session.ended, !session.working,
           !session.waitingForRemoval, !waitForRemoval {
            if let errorMessage {
                scan.completionErrorMessage = errorMessage
                scan.reader.alertMessage = errorMessage
            } else if let message {
                scan.completedSuccessfully = true
                scan.reader.alertMessage = message
            }
        }

        if waitForRemoval {
            session.waitingForRemoval = true
            session.removing.append(completion)
        } else {
            session.closing.append(completion)
        }
        endSession(scan, session, reason: "closed", code: "CANCELLED")

        if scan.endCode != nil { return }
        if session.working {
            // Closing during connect or send cannot safely keep this reader.
            endScan(scan, reason: "stopped", code: "CANCELLED")
        } else {
            finishClosing(scan, session)
        }
    }

    func stop(id: String, completion: @escaping Completion) {
        retiredIds.insert(id)
        if pendingScan?.id == id {
            cancelPending(reason: "stopped", code: "CANCELLED")
        }
        guard let scan, scan.id == id else {
            completion(.success(()))
            return
        }
        if scan.completedSuccessfully, scan.endCode == nil, scan.session == nil {
            // The operation is finished when successful invalidation begins.
            // Keep this reader reserved until didInvalidate releases its RF state.
            endScan(scan, reason: "stopped", code: "CANCELLED")
            scan.stopAcknowledged = true
        }
        if scan.stopAcknowledged {
            completion(.success(()))
            return
        }
        scan.stopping.append(completion)
        endScan(scan, reason: "stopped", code: "CANCELLED")
    }

    func terminate(reason: String, code: String) {
        cancelPending(reason: reason, code: code)
        guard let scan else { return }
        endScan(scan, reason: reason, code: code)
    }

    private func cancelPending(reason: String, code: String) {
        guard let pending = pendingScan else { return }
        pendingScan = nil
        retiredIds.insert(pending.id)
        let completion = pending.starting
        pending.starting = nil
        completion?(.failure(NFCFailure(code: code, message: "The NFC scan ended: \(reason).")))
    }

    private func endSession(_ scan: Scan, _ session: Session, reason: String, code: String) {
        guard !session.ended else { return }
        session.ended = true
        session.removed = code == "TAG_LOST"
        // Keep the failed operation's presentation through cleanup and any
        // rediscovery that races the caller's eventual stopScan.
        if code == "TAG_LOST" { scan.connectionLost = true }
        session.cancelDeadline?()
        session.cancelDeadline = nil
        session.cancelRemovalCheck?()
        session.cancelRemovalCheck = nil
        let exchange = session.exchange
        session.exchange = nil
        exchange?(.failure(NFCFailure(code: code, message: "The NFC session ended: \(reason).", outcome: "unknown")))

        var event: [String: Any] = ["scanId": scan.id, "sessionId": session.id, "reason": reason]
        if code != "CANCELLED" { event["code"] = code }
        emit("sessionEnded", event)
    }

    private func endScan(_ scan: Scan, reason: String, code: String, invalidate: Bool = true) {
        guard scan.endCode == nil else { return }
        scan.endCode = code
        retiredIds.insert(scan.id)
        if let session = scan.session {
            let sessionReason = reason == "stopped" || reason == "cancelled" ? "scan-stopped" : reason == "timeout" ? "scan-timeout" : reason
            endSession(scan, session, reason: sessionReason, code: code)
            session.cancelRemovalCheck?()
            session.cancelRemovalCheck = nil
        }

        let starting = scan.starting
        scan.starting = nil
        starting?(.failure(NFCFailure(code: code, message: "The NFC scan ended: \(reason).")))
        var event: [String: Any] = ["scanId": scan.id, "reason": reason]
        if reason != "stopped" { event["code"] = code }
        emit("scanEnded", event)
        if invalidate {
            let errorMessage = reason == "stopped"
                ? (scan.connectionLost ? "Card connection lost." : scan.completionErrorMessage)
                : nil
            scan.reader.invalidate(errorMessage: errorMessage)
        }
    }

    func invalidated(_ reader: NFCScanDriver, failure: NFCFailure) {
        guard let scan, scan.reader === reader else { return }
        let reason: String
        switch failure.code {
        case "CANCELLED": reason = "cancelled"
        case "TIMEOUT": reason = "timeout"
        case "APP_INACTIVE": reason = "app-paused"
        case "NFC_DISABLED": reason = "nfc-disabled"
        default: reason = "io-error"
        }
        endScan(scan, reason: reason, code: failure.code, invalidate: false)

        // didInvalidate is the native cleanup barrier. Late connect/send
        // callbacks belong to the old reader and cannot affect a new scan.
        self.scan = nil
        reader.events = nil
        if let session = scan.session {
            for completion in session.closing { completion(.success(())) }
            for completion in session.removing {
                completion(.failure(NFCFailure(code: scan.endCode ?? failure.code, message: "The NFC scan ended while waiting for card removal.")))
            }
        }
        for completion in scan.stopping { completion(.success(())) }
        if let pending = pendingScan {
            pendingScan = nil
            begin(pending)
        }
    }

    private func finishClosing(_ scan: Scan, _ session: Session) {
        guard self.scan === scan, scan.endCode == nil, !session.working else { return }
        let closing = session.closing
        session.closing.removeAll()

        if session.waitingForRemoval && !session.removed {
            // A failed connect never establishes availability, so `false` in
            // that state cannot establish removal. Do not invent a re-tap.
            guard session.connected else {
                for completion in closing { completion(.success(())) }
                let removing = session.removing
                session.removing.removeAll()
                for completion in removing {
                    completion(.failure(NFCFailure(code: "UNSUPPORTED", message: "Removal cannot be detected after an unsuccessful connection on iOS.")))
                }
                endScan(scan, reason: "io-error", code: "UNSUPPORTED")
                return
            }

            scan.reader.alertMessage = "Remove the card before scanning it again."
            for completion in closing { completion(.success(())) }
            checkRemoval(scan, session)
            return
        }

        release(scan, session)
        for completion in closing { completion(.success(())) }
    }

    private func checkRemoval(_ scan: Scan, _ session: Session) {
        guard self.scan === scan, scan.endCode == nil, scan.session === session else { return }
        if scan.reader.isReady && !session.card.isAvailable {
            session.removed = true
            release(scan, session)
            return
        }
        guard session.cancelRemovalCheck == nil else { return }
        session.cancelRemovalCheck = schedule(250) { [weak self, weak scan, weak session] in
            guard let self, let scan, let session else { return }
            session.cancelRemovalCheck = nil
            self.checkRemoval(scan, session)
        }
    }

    private func release(_ scan: Scan, _ session: Session) {
        session.cancelRemovalCheck?()
        session.cancelRemovalCheck = nil
        if session.removed { scan.removedSessionId = session.id }
        scan.session = nil
        // Keep progress visible while the caller closes the scan. Only an
        // explicit removal gate asks for another tap.
        if session.waitingForRemoval {
            scan.reader.alertMessage = "Hold your card near the top of your iPhone."
        }
        if !scan.completedSuccessfully, scan.completionErrorMessage == nil {
            scan.reader.restartPolling()
        }
        for completion in session.removing { completion(.success(())) }
        session.removing.removeAll()
    }

    private func reason(for code: String) -> String {
        code == "TAG_LOST" ? "tag-lost" : "io-error"
    }
}
