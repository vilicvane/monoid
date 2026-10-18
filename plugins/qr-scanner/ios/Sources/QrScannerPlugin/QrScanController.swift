import Foundation

protocol QrScanSession: AnyObject {
    func update(_ bounds: QrPreviewBounds) throws
    func animate(_ animation: QrPreviewAnimation)
    func close(completion: @escaping () -> Void)
}

struct QrScanCallbacks {
    let started: () -> Void
    let codes: ([String]) -> Void
    let failed: (QrScannerFailure) -> Void
}

struct QrScanEnded {
    let scanId: String
    let reason: String
    let error: QrScannerFailure?
}

/// All state transitions, session callbacks and callers run on the main queue.
final class QrScanController {
    typealias Completion = (Result<Void, QrScannerFailure>) -> Void
    typealias Factory = (QrPreviewBounds, QrScanCallbacks) throws -> QrScanSession

    private let factory: Factory
    private let codes: (String, [String]) -> Void
    private let ended: (QrScanEnded) -> Void
    private var retired = Set<String>()
    private var current: Scan?

    init(factory: @escaping Factory, codes: @escaping (String, [String]) -> Void, ended: @escaping (QrScanEnded) -> Void) {
        self.factory = factory
        self.codes = codes
        self.ended = ended
    }

    func start(id: String, bounds: QrPreviewBounds, completion: @escaping Completion) {
        guard !retired.contains(id) else {
            completion(.failure(QrScannerFailure(code: "SCAN_CLOSED", message: "This scan ID has already ended.")))
            return
        }
        guard current == nil else {
            completion(.failure(QrScannerFailure(code: "BUSY", message: "Another scan is starting or active.")))
            return
        }
        let scan = Scan(id: id, start: completion)
        current = scan
        let callbacks = QrScanCallbacks(
            started: { [weak self, weak scan] in
                guard let self, let scan, self.current === scan, !scan.started, !scan.closing else { return }
                scan.started = true
                scan.start?(.success(()))
                scan.start = nil
            },
            codes: { [weak self, weak scan] values in
                guard let self, let scan, self.current === scan, scan.started, !scan.closing else { return }
                self.codes(id, values)
            },
            failed: { [weak self, weak scan] error in
                guard let self, let scan, self.current === scan else { return }
                self.close(scan, reason: "error", error: error)
            })
        do {
            // The factory returns a cancellable handle before delivering any callback.
            scan.session = try factory(bounds, callbacks)
        } catch {
            close(scan, reason: "error", error: error as? QrScannerFailure
                ?? QrScannerFailure(code: "CAMERA_ERROR", message: error.localizedDescription))
        }
    }

    func update(id: String, bounds: QrPreviewBounds, completion: Completion) {
        guard let scan = current, scan.id == id, !scan.closing else {
            completion(.failure(closedError))
            return
        }
        do {
            try scan.session?.update(bounds)
            completion(.success(()))
        } catch {
            completion(.failure(error as? QrScannerFailure
                ?? QrScannerFailure(code: "CAMERA_ERROR", message: error.localizedDescription)))
        }
    }

    func animate(id: String, animation: QrPreviewAnimation, completion: Completion) {
        guard let scan = current, scan.id == id, scan.started, !scan.closing else {
            completion(.failure(closedError))
            return
        }
        scan.session?.animate(animation)
        completion(.success(()))
    }

    func stop(id: String, completion: @escaping Completion) {
        retired.insert(id)
        guard let scan = current, scan.id == id else {
            completion(.success(()))
            return
        }
        scan.stops.append(completion)
        close(scan, reason: "stopped", error: QrScannerFailure(code: "CANCELLED", message: "Scan startup was cancelled."))
    }

    func pause() {
        if let scan = current {
            close(scan, reason: "app-paused", error: QrScannerFailure(code: "CANCELLED", message: "Scan startup was cancelled because the app paused."))
        }
    }

    func reset() {
        if let scan = current {
            scan.silent = true
            close(scan, reason: "stopped", error: QrScannerFailure(code: "CANCELLED", message: "Scan startup was cancelled."))
        }
        retired.removeAll()
    }

    private var closedError: QrScannerFailure {
        QrScannerFailure(code: "SCAN_CLOSED", message: "The camera preview is not active.")
    }

    private func close(_ scan: Scan, reason: String, error: QrScannerFailure) {
        guard !scan.closing else { return }
        scan.closing = true
        retired.insert(scan.id)
        let finish = { [self] in
            current = nil
            guard !scan.silent else { return }
            if !scan.started {
                scan.start?(.failure(error))
                scan.start = nil
            } else {
                ended(QrScanEnded(scanId: scan.id, reason: reason, error: reason == "error" ? error : nil))
            }
            for completion in scan.stops { completion(.success(())) }
            scan.stops.removeAll()
        }
        if let session = scan.session {
            session.close(completion: finish)
        } else {
            finish()
        }
    }

    private final class Scan {
        let id: String
        var start: Completion?
        var stops: [Completion] = []
        var session: QrScanSession?
        var started = false
        var closing = false
        var silent = false

        init(id: String, start: @escaping Completion) {
            self.id = id
            self.start = start
        }
    }
}
