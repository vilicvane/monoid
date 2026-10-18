import XCTest

@testable import BiometricVaultPlugin

final class VaultArgumentsTests: XCTestCase {
    func testUTF8LimitsAndWhitespacePreservation() throws {
        XCTAssertEqual(try VaultArguments.text(" pin ", name: "id", limit: 512, utf8: true), " pin ")
        XCTAssertEqual(try VaultArguments.text("", name: "value", limit: 65_536, utf8: true, allowEmpty: true), "")
        XCTAssertThrowsError(
            try VaultArguments.text(String(repeating: "密", count: 171), name: "id", limit: 512, utf8: true))
        XCTAssertNoThrow(
            try VaultArguments.text(String(repeating: "密", count: 170), name: "id", limit: 512, utf8: true))
    }

    func testRequiredStringsRejectWrongTypesAndUnicodeWhitespace() {
        for value: Any in [NSNull(), 42, true, "", " \n\t", "\u{00a0}"] {
            XCTAssertThrowsError(try VaultArguments.text(value, name: "id", limit: 512, utf8: true)) {
                XCTAssertEqual(($0 as? VaultError)?.code, "INVALID_ARGUMENT")
            }
        }
    }

    func testReasonLimitUsesUTF16LikeAndroidAndAllowsPairedSurrogates() {
        XCTAssertNoThrow(try VaultArguments.text(String(repeating: "🔐", count: 128), name: "reason", limit: 256))
        XCTAssertThrowsError(try VaultArguments.text(String(repeating: "🔐", count: 129), name: "reason", limit: 256))
    }

    func testUnpairedSurrogatesAreRejectedBeforeSwiftStringRepair() {
        for units: [unichar] in [[0xD800], [0xDC00], [0xD800, 0x0041]] {
            let malformed = NSString(characters: units, length: units.count)
            XCTAssertThrowsError(try VaultArguments.text(malformed, name: "value", limit: 65_536, allowEmpty: true)) {
                XCTAssertEqual(($0 as? VaultError)?.code, "INVALID_ARGUMENT")
            }
        }
    }
}
