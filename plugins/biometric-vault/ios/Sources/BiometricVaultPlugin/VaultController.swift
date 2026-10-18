import Foundation

/// Queue transitions run on the main/control executor. A short authorization lock
/// serializes revocation with noninteractive Keychain commits on the worker.
final class VaultController {
    typealias Completion = (Result<String?, VaultError>) -> Void
    typealias Executor = (@escaping () -> Void) -> Void

    private enum Operation { case authenticate, get, set, remove, clear }

    private final class Access {
        let id = UUID().uuidString
        let authentication: VaultAuthenticating
        let deadline: TimeInterval
        var closed: VaultError?
        var closeWaiters: [Completion] = []

        init(authentication: VaultAuthenticating, deadline: TimeInterval) {
            self.authentication = authentication
            self.deadline = deadline
        }

        func close(_ error: VaultError) {
            guard closed == nil else { return }
            closed = error
            authentication.invalidate()
        }
    }

    private final class Request {
        let requestId: String?
        let operation: Operation
        let access: Access?
        let id: String?
        let value: String?
        let completion: Completion
        var authentication: VaultAuthenticating?
        var cancelled: VaultError?
        var committed = false
        var finished = false

        init(
            _ operation: Operation, requestId: String?, access: Access? = nil,
            id: String? = nil, value: String? = nil, completion: @escaping Completion
        ) {
            self.operation = operation
            self.requestId = requestId
            self.access = access
            self.id = id
            self.value = value
            self.completion = completion
        }
    }

    private let store: VaultStoring
    private let makeAuthentication: () -> VaultAuthenticating
    private let control: Executor
    private let worker: Executor
    private let clock: () -> TimeInterval
    private let scheduleExpiry: (TimeInterval, @escaping () -> Void) -> Void
    private let lock = NSRecursiveLock()
    private var accesses: [String: Access] = [:]
    private var usedRequestIds = Set<String>()
    private var queued: [Request] = []
    private var active: Request?
    private var foreground = false
    private var deliveryDepth = 0

    init(
        store: VaultStoring, makeAuthentication: @escaping () -> VaultAuthenticating,
        control: @escaping Executor, worker: @escaping Executor,
        clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        scheduleExpiry: @escaping (TimeInterval, @escaping () -> Void) -> Void = {
            DispatchQueue.main.asyncAfter(deadline: .now() + $0, execute: $1)
        }
    ) {
        self.store = store
        self.makeAuthentication = makeAuthentication
        self.control = control
        self.worker = worker
        self.clock = clock
        self.scheduleExpiry = scheduleExpiry
    }

    func authenticate(requestId: String, reason: String, completion: @escaping Completion) {
        enqueue(Request(.authenticate, requestId: requestId, value: reason, completion: completion))
    }

    func get(accessId: String, id: String, requestId: String, completion: @escaping Completion) {
        enqueueScoped(.get, accessId: accessId, id: id, requestId: requestId, completion: completion)
    }

    func set(accessId: String, id: String, value: String, requestId: String, completion: @escaping Completion) {
        enqueueScoped(.set, accessId: accessId, id: id, value: value, requestId: requestId, completion: completion)
    }

    func remove(accessId: String?, id: String, requestId: String?, completion: @escaping Completion) {
        if let accessId {
            enqueueScoped(.remove, accessId: accessId, id: id, requestId: requestId, completion: completion)
        } else {
            enqueue(Request(.remove, requestId: nil, id: id, completion: completion))
        }
    }

    func clear(completion: @escaping Completion) {
        enqueue(Request(.clear, requestId: nil, completion: completion))
    }

    private func enqueueScoped(
        _ operation: Operation, accessId: String, id: String, value: String? = nil,
        requestId: String?, completion: @escaping Completion
    ) {
        do {
            let access = try locked {
                guard foreground else { throw VaultError.inactive }
                guard let access = accesses[accessId] else { throw VaultError.closed }
                try checkAccess(access)
                return access
            }
            enqueue(
                Request(operation, requestId: requestId, access: access, id: id, value: value, completion: completion))
        } catch {
            completion(.failure(error as? VaultError ?? .storage))
        }
    }

    private func enqueue(_ request: Request) {
        if let requestId = request.requestId, !usedRequestIds.insert(requestId).inserted {
            request.completion(.failure(.cancelled))
            return
        }
        guard locked({ foreground }) else {
            request.completion(.failure(.inactive))
            return
        }
        queued.append(request)
        advance()
    }

    func closeAccess(_ id: String, completion: @escaping Completion) {
        let access = locked { () -> Access? in
            let access = accesses.removeValue(forKey: id) ?? (active?.access?.id == id ? active?.access : nil)
            access?.close(.closed)
            return access
        }
        guard let access else {
            completion(.success(nil))
            return
        }

        let abandoned = queued.filter { $0.access === access }
        queued.removeAll { $0.access === access }
        deliveryDepth += 1
        if let active, active.access === access {
            access.closeWaiters.append(completion)
            cancel(active, error: .closed)
        } else {
            completion(.success(nil))
        }
        for request in abandoned {
            cancel(request, error: .closed)
            deliver(request, result: .failure(.closed))
        }
        deliveryDepth -= 1
        advance()
    }

    func cancel(requestId: String) {
        usedRequestIds.insert(requestId)
        if let active, active.requestId == requestId {
            cancel(active, error: .cancelled)
        } else if let index = queued.firstIndex(where: { $0.requestId == requestId }) {
            let request = queued.remove(at: index)
            cancel(request, error: .cancelled)
            deliveryDepth += 1
            deliver(request, result: .failure(.cancelled))
            deliveryDepth -= 1
            advance()
        }
    }

    func setForeground(_ foreground: Bool) {
        locked {
            self.foreground = foreground
            if !foreground {
                for access in accesses.values { access.close(.inactive) }
                accesses.removeAll()
            }
        }
        if !foreground {
            let abandoned = queued
            queued.removeAll()
            deliveryDepth += 1
            if let active, active.requestId != nil { cancel(active, error: .inactive) }
            for request in abandoned {
                cancel(request, error: .inactive)
                deliver(request, result: .failure(.inactive))
            }
            deliveryDepth -= 1
        }
        advance()
    }

    private func advance() {
        guard active == nil, deliveryDepth == 0, locked({ foreground }), !queued.isEmpty else { return }
        let request = queued.removeFirst()
        active = request
        do {
            try locked { try check(request) }
        } catch {
            settle(request, result: .failure(error as? VaultError ?? .storage))
            return
        }

        if request.operation == .authenticate {
            let authentication = makeAuthentication()
            request.authentication = authentication
            authentication.authenticate(reason: request.value!) { [self] error in
                let authenticatedAt = clock()
                control { [self] in
                    guard active === request else { return }
                    var result: Result<String?, VaultError>
                    do {
                        result = try locked {
                            try check(request)
                            if let error { throw error }
                            let access = Access(authentication: authentication, deadline: authenticatedAt + 60)
                            try checkAccess(access)
                            accesses[access.id] = access
                            scheduleExpiry(max(0, access.deadline - clock())) { [weak self, weak access] in
                                guard let self, let access else { return }
                                self.locked { access.close(.expired) }
                            }
                            return .success(access.id)
                        }
                    } catch {
                        authentication.invalidate()
                        result = .failure(error as? VaultError ?? .storage)
                    }
                    request.authentication = nil
                    settle(request, result: result)
                }
            }
            return
        }

        worker { [self] in
            let result: Result<String?, VaultError>
            do {
                try locked { try check(request) }
                if request.operation == .get {
                    // Decryption can finish after revocation, but deliver checks again before
                    // returning plaintext. No plaintext or raw encryption keys are cached.
                    result = .success(try store.get(id: request.id!, context: request.access!.authentication.context))
                } else {
                    try locked {
                        try check(request)
                        switch request.operation {
                        case .set:
                            try store.set(
                                id: request.id!, value: request.value!, context: request.access!.authentication.context)
                        case .remove:
                            try store.remove(id: request.id!)
                        case .clear:
                            try store.clear()
                        default: preconditionFailure("Unexpected vault operation")
                        }
                        request.committed = true
                    }
                    result = .success(nil)
                }
            } catch {
                result = .failure(error as? VaultError ?? .storage)
            }
            control { [self] in settle(request, result: result) }
        }
    }

    private func cancel(_ request: Request, error: VaultError) {
        locked {
            guard !request.finished, !request.committed, request.cancelled == nil else { return }
            request.cancelled = error
            request.authentication?.invalidate()
        }
    }

    private func settle(_ request: Request, result: Result<String?, VaultError>) {
        guard active === request, !request.finished else { return }
        deliveryDepth += 1
        deliver(request, result: result)
        active = nil
        let waiters = request.access?.closeWaiters ?? []
        request.access?.closeWaiters.removeAll()
        for waiter in waiters { waiter(.success(nil)) }
        deliveryDepth -= 1
        advance()
    }

    private func deliver(_ request: Request, result: Result<String?, VaultError>) {
        let result = locked { () -> Result<String?, VaultError> in
            var result = result
            if !request.committed {
                do { try check(request) } catch { result = .failure(error as? VaultError ?? .storage) }
            }
            if case .failure(let error) = result, error.code == "AUTHORIZATION_EXPIRED" {
                request.access?.close(error)
            }
            request.finished = true
            return result
        }
        request.completion(result)
    }

    private func check(_ request: Request) throws {
        if request.committed { return }
        if let error = request.cancelled { throw error }
        guard foreground else { throw VaultError.inactive }
        if let access = request.access { try checkAccess(access) }
    }

    private func checkAccess(_ access: Access) throws {
        if let error = access.closed { throw error }
        if clock() >= access.deadline {
            access.close(.expired)
            throw VaultError.expired
        }
    }

    private func locked<T>(_ action: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try action()
    }
}
