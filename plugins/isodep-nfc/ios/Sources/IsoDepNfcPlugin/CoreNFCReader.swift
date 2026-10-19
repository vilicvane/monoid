import CoreNFC
import Foundation

final class CoreNFCCard: NFCCard {
    let tag: NFCISO7816Tag
    private weak var reader: NFCTagReaderSession?

    init(_ tag: NFCISO7816Tag, reader: NFCTagReaderSession) {
        self.tag = tag
        self.reader = reader
    }

    var identifier: [UInt8] { Array(tag.identifier) }
    var isAvailable: Bool { tag.isAvailable }

    func transceive(_ bytes: [UInt8], completion: @escaping (Result<[UInt8], NFCFailure>) -> Void) {
        // The encoded-data initializer preserves short/extended Lc/Le framing.
        // Rebuilding the command from fields could silently change its bytes.
        guard let apdu = NFCISO7816APDU(data: Data(bytes)) else {
            completion(.failure(NFCFailure(code: "INVALID_ARGUMENT", message: "iOS requires a valid ISO 7816 command APDU.", outcome: "not-sent")))
            return
        }

        tag.sendCommand(apdu: apdu) { data, sw1, sw2, error in
            if let error {
                completion(.failure(CoreNFCReader.transceiveFailure(error, tagAvailable: self.tag.isAvailable, readerReady: self.reader?.isReady == true)))
            } else {
                completion(.success(Array(data) + [sw1, sw2]))
            }
        }
    }
}

final class CoreNFCReader: NSObject, NFCScanDriver, NFCTagReaderSessionDelegate {
    weak var events: NFCScanEvents?
    private var reader: NFCTagReaderSession!

    static var available: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return NFCTagReaderSession.readingAvailable
        #endif
    }

    init?(queue: DispatchQueue) {
        super.init()
        guard let reader = NFCTagReaderSession(pollingOption: .iso14443, delegate: self, queue: queue) else { return nil }
        self.reader = reader
        reader.alertMessage = "Hold your card near the top of your iPhone."
    }

    var alertMessage: String {
        get { reader.alertMessage }
        set { reader.alertMessage = newValue }
    }

    var isReady: Bool { reader.isReady }

    func begin() { reader.begin() }
    func invalidate(errorMessage: String?) {
        if let errorMessage {
            reader.invalidate(errorMessage: errorMessage)
        } else {
            reader.invalidate()
        }
    }
    func restartPolling() { reader.restartPolling() }

    func connect(_ card: NFCCard, completion: @escaping (NFCFailure?) -> Void) {
        guard let card = card as? CoreNFCCard else {
            completion(NFCFailure(code: "UNSUPPORTED", message: "The tag is not an ISO 7816 card."))
            return
        }
        reader.connect(to: .iso7816(card.tag)) { error in
            completion(error.map(Self.failure))
        }
    }

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) {
        events?.activated(self)
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        events?.invalidated(self, failure: Self.failure(error))
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        guard events?.canDiscover(self) == true else { return }
        guard tags.count == 1 else {
            session.alertMessage = "Present one card at a time."
            session.restartPolling()
            return
        }
        guard case .iso7816(let tag) = tags[0] else {
            session.alertMessage = "Present an ISO 7816 card supported by this app."
            session.restartPolling()
            return
        }
        session.alertMessage = "Keep your card near the top of your iPhone."
        events?.detected(self, card: CoreNFCCard(tag, reader: session))
    }

    static func transceiveFailure(_ error: Error, tagAvailable: Bool, readerReady: Bool) -> NFCFailure {
        // Core NFC can report a response/retry error when a connected card leaves
        // the field. Require independent RF loss while the reader is still live;
        // invalidating a reader also makes its tags unavailable.
        if readerReady, !tagAvailable, let error = error as? NFCReaderError,
           error.code == .readerTransceiveErrorTagResponseError || error.code == .readerTransceiveErrorRetryExceeded {
            return NFCFailure(code: "TAG_LOST", message: "The card connection was lost.")
        }
        return failure(error)
    }

    static func failure(_ error: Error) -> NFCFailure {
        guard let error = error as? NFCReaderError else {
            return NFCFailure(code: "IO_ERROR", message: "Communication with the NFC reader failed.")
        }
        let code: String
        let message: String
        switch error.code {
        case .readerErrorUnsupportedFeature:
            code = "UNSUPPORTED"
            message = "NFC tag reading is not supported on this device."
        case .readerErrorSecurityViolation:
            code = "UNSUPPORTED"
            message = "This app is not entitled to access the NFC reader or selected application."
        case .readerErrorRadioDisabled:
            code = "NFC_DISABLED"
            message = "The NFC radio is unavailable."
        case .readerErrorInvalidParameter, .readerErrorInvalidParameterLength, .readerErrorParameterOutOfBound:
            code = "INVALID_ARGUMENT"
            message = "Core NFC rejected the APDU parameters."
        case .readerTransceiveErrorTagConnectionLost:
            code = "TAG_LOST"
            message = "The card connection was lost."
        case .readerTransceiveErrorTagNotConnected:
            code = "SESSION_CLOSED"
            message = "The card is no longer connected."
        case .readerTransceiveErrorPacketTooLong:
            code = "DATA_TOO_LARGE"
            message = "The APDU exceeds the NFC reader's supported length."
        case .readerSessionInvalidationErrorUserCanceled:
            code = "CANCELLED"
            message = "NFC scanning was cancelled."
        case .readerSessionInvalidationErrorSessionTimeout:
            code = "TIMEOUT"
            message = "The iOS NFC reader session timed out."
        case .readerSessionInvalidationErrorSystemIsBusy:
            code = "BUSY"
            message = "The NFC reader is in use."
        default:
            code = "IO_ERROR"
            message = "Communication with the NFC reader failed."
        }
        return NFCFailure(code: code, message: message)
    }
}
