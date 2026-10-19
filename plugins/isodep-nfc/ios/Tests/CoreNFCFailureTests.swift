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

    func testTransferErrorsRequireUnavailableTagAndLiveReaderToReportLoss() {
        for code in [NFCReaderError.Code.readerTransceiveErrorTagResponseError, .readerTransceiveErrorRetryExceeded] {
            let error = NSError(domain: NFCErrorDomain, code: code.rawValue)
            for tagAvailable in [true, false] {
                for readerReady in [true, false] {
                    let failure = CoreNFCReader.transceiveFailure(error, tagAvailable: tagAvailable, readerReady: readerReady)
                    XCTAssertEqual(failure.code, !tagAvailable && readerReady ? "TAG_LOST" : "IO_ERROR")
                    XCTAssertNil(failure.outcome)
                }
            }
            // Connect/invalidation callbacks cannot establish loss of a previously connected tag.
            XCTAssertEqual(CoreNFCReader.failure(error).code, "IO_ERROR")
        }
    }

    func testUnavailableTagDoesNotMaskOtherNativeFailures() {
        let cases: [(NFCReaderError.Code, String)] = [
            (.readerErrorSecurityViolation, "UNSUPPORTED"),
            (.readerErrorInvalidParameter, "INVALID_ARGUMENT"),
            (.readerTransceiveErrorPacketTooLong, "DATA_TOO_LARGE"),
            (.readerTransceiveErrorTagNotConnected, "SESSION_CLOSED"),
            (.readerTransceiveErrorSessionInvalidated, "IO_ERROR"),
            (.readerSessionInvalidationErrorUserCanceled, "CANCELLED"),
            (.readerSessionInvalidationErrorSessionTimeout, "TIMEOUT")
        ]
        for (code, expected) in cases {
            let error = NSError(domain: NFCErrorDomain, code: code.rawValue)
            XCTAssertEqual(CoreNFCReader.transceiveFailure(error, tagAvailable: false, readerReady: true).code, expected)
        }
        let unrelated = NSError(domain: "OtherTransport", code: 102)
        XCTAssertEqual(CoreNFCReader.transceiveFailure(unrelated, tagAvailable: false, readerReady: true).code, "IO_ERROR")
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
