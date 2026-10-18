import CoreNFC
import XCTest
@testable import IsoDepNfcPlugin

final class CoreNFCFailureTests: XCTestCase {
    private func failure(_ code: NFCReaderError.Code) -> NFCFailure {
        CoreNFCReader.failure(NSError(domain: NFCErrorDomain, code: code.rawValue))
    }

    func testDisconnectionDoesNotAssertCardRemoval() {
        XCTAssertEqual(failure(.readerTransceiveErrorTagNotConnected).code, "SESSION_CLOSED")
        XCTAssertEqual(failure(.readerTransceiveErrorTagConnectionLost).code, "TAG_LOST")
    }

    func testNativeCancellationTimeoutAndBusyRemainDistinct() {
        XCTAssertEqual(failure(.readerSessionInvalidationErrorUserCanceled).code, "CANCELLED")
        XCTAssertEqual(failure(.readerSessionInvalidationErrorSessionTimeout).code, "TIMEOUT")
        XCTAssertEqual(failure(.readerSessionInvalidationErrorSystemIsBusy).code, "BUSY")
    }

    func testEntitlementAndPayloadLimitsAreActionable() {
        XCTAssertEqual(failure(.readerErrorSecurityViolation).code, "UNSUPPORTED")
        XCTAssertEqual(failure(.readerTransceiveErrorPacketTooLong).code, "DATA_TOO_LARGE")
        XCTAssertEqual(failure(.readerErrorInvalidParameter).code, "INVALID_ARGUMENT")
        XCTAssertEqual(failure(.readerErrorRadioDisabled).code, "NFC_DISABLED")
        XCTAssertEqual(failure(.readerTransceiveErrorTagResponseError).code, "IO_ERROR")
        XCTAssertNil(failure(.readerTransceiveErrorTagResponseError).outcome)
    }

    func testUnknownErrorsDoNotExposeNativePayloads() {
        let error = NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: "Secret APDU payload"])
        let failure = CoreNFCReader.failure(error)
        XCTAssertEqual(failure.code, "IO_ERROR")
        XCTAssertFalse(failure.message.contains("Secret"))
    }
}
