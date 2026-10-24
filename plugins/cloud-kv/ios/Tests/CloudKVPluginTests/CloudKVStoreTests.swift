import Foundation
import XCTest

@testable import CloudKVPlugin

private final class MemoryBackend: CloudKVBackend {
    var values: [String: Any] = [:]
    var synchronizeCount = 0

    func string(forKey aKey: String) -> String? { values[aKey] as? String }

    func set(_ aString: String?, forKey aKey: String) { values[aKey] = aString }

    func removeObject(forKey aKey: String) { values.removeValue(forKey: aKey) }

    var dictionaryRepresentation: [String: Any] { values }

    func synchronize() -> Bool {
        synchronizeCount += 1
        return true
    }
}

final class CloudKVStoreTests: XCTestCase {
    private var backend: MemoryBackend!
    private var store: CloudKVStore!

    override func setUp() {
        backend = MemoryBackend()
        store = CloudKVStore(backend: backend)
    }

    func testSetGetRemove() throws {
        XCTAssertNil(try store.get("a"))
        try store.set("a", value: "")
        XCTAssertEqual(try store.get("a"), "")
        try store.remove("a")
        XCTAssertNil(try store.get("a"))
        try store.remove("missing")
    }

    func testRejectsInvalidKeys() {
        XCTAssertThrowsError(try store.get("")) {
            XCTAssertEqual(($0 as? CloudKVError)?.code, "INVALID_ARGUMENT")
        }
        // 22 three-byte characters exceed 64 UTF-8 bytes in 22 UTF-16 code units.
        XCTAssertThrowsError(try store.set(String(repeating: "钥", count: 22), value: "v"))
        XCTAssertNoThrow(try store.set(String(repeating: "k", count: 64), value: "v"))
    }

    func testRejectsKeyCountOverflowWithoutWriting() throws {
        for index in 0..<CloudKVLimits.maxKeys {
            backend.values["k\(index)"] = ""
        }
        try store.set("k0", value: "replaced")
        XCTAssertThrowsError(try store.set("extra", value: "")) {
            XCTAssertEqual(($0 as? CloudKVError)?.code, "QUOTA_EXCEEDED")
        }
        XCTAssertNil(backend.values["extra"])
    }

    func testRejectsSizeOverflowAndCountsReplacementOnce() throws {
        let half = String(repeating: "x", count: CloudKVLimits.maxTotalBytes / 2 - 1)
        try store.set("a", value: half)
        try store.set("b", value: half)
        try store.set("a", value: half)
        XCTAssertThrowsError(try store.set("c", value: "x")) {
            XCTAssertEqual(($0 as? CloudKVError)?.code, "QUOTA_EXCEEDED")
        }
    }

    func testListFiltersPrefixSortsAndSkipsNonStrings() throws {
        try store.set("sk/b", value: "2")
        try store.set("sk/a", value: "1")
        try store.set("other", value: "3")
        backend.values["sk/number"] = 4

        let entries = store.list(prefix: "sk/")
        XCTAssertEqual(entries.map { $0.key }, ["sk/a", "sk/b"])
        XCTAssertEqual(entries.map { $0.value }, ["1", "2"])
        XCTAssertEqual(store.list(prefix: "").count, 3)
    }

    func testChangeReasons() {
        XCTAssertEqual(CloudKVStore.changeReason(NSUbiquitousKeyValueStoreServerChange), "server")
        XCTAssertEqual(CloudKVStore.changeReason(NSUbiquitousKeyValueStoreInitialSyncChange), "initial-sync")
        XCTAssertEqual(CloudKVStore.changeReason(NSUbiquitousKeyValueStoreQuotaViolationChange), "quota-violation")
        XCTAssertEqual(CloudKVStore.changeReason(NSUbiquitousKeyValueStoreAccountChange), "account-change")
        XCTAssertEqual(CloudKVStore.changeReason(nil), "unknown")
    }
}
