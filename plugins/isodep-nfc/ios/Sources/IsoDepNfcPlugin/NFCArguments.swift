import CoreFoundation
import Foundation

enum NFCArguments {
    static func id(_ options: [String: Any], key: String) throws -> String {
        guard let value = options[key] as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NFCFailure(code: "INVALID_ARGUMENT", message: "\(key) must be a nonblank string.")
        }
        return value
    }

    static func timeout(_ options: [String: Any], key: String) throws -> Int? {
        guard let value = options[key] else { return nil }
        guard let value = integer(value, range: 1...Int(Int32.max)) else {
            throw NFCFailure(code: "INVALID_ARGUMENT", message: "\(key) must be a positive 32-bit integer.")
        }
        return value
    }

    static func message(_ options: [String: Any], key: String = "message", allowEmpty: Bool = false) throws -> String {
        guard let value = options[key] as? String,
              (allowEmpty && value.isEmpty) || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            let requirement = allowEmpty ? "empty or a nonblank string" : "a nonblank string"
            throw NFCFailure(code: "INVALID_ARGUMENT", message: "\(key) must be \(requirement).")
        }
        return value
    }

    static func closeMessages(_ options: [String: Any]) throws -> (message: String?, errorMessage: String?) {
        guard options["message"] == nil || options["errorMessage"] == nil else {
            throw NFCFailure(code: "INVALID_ARGUMENT", message: "message and errorMessage cannot be combined.")
        }
        let finalMessage = options["message"] == nil ? nil : try message(options, allowEmpty: true)
        let errorMessage = options["errorMessage"] == nil ? nil : try message(options, key: "errorMessage")
        return (finalMessage, errorMessage)
    }

    static func bytes(_ options: [String: Any]) throws -> [UInt8] {
        guard let values = options["data"] as? [Any], !values.isEmpty else {
            throw NFCFailure(code: "INVALID_ARGUMENT", message: "data must be a nonempty array of bytes.")
        }
        return try values.map { value in
            guard let byte = integer(value, range: 0...255) else {
                throw NFCFailure(code: "INVALID_ARGUMENT", message: "data must contain only integer bytes from 0 through 255.")
            }
            return UInt8(byte)
        }
    }

    static func waitForRemoval(_ options: [String: Any]) throws -> Bool {
        guard let value = options["waitForRemoval"] else { return false }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw NFCFailure(code: "INVALID_ARGUMENT", message: "waitForRemoval must be a boolean.")
        }
        return number.boolValue
    }

    private static func integer(_ value: Any, range: ClosedRange<Int>) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value.rounded(.towardZero) == value,
              value >= Double(range.lowerBound), value <= Double(range.upperBound) else { return nil }
        return Int(value)
    }
}
