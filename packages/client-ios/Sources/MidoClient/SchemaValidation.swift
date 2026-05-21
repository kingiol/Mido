import Foundation

public enum MidoClientError: Error, LocalizedError, Sendable {
  case invalidToolDefinition(String)
  case unknownToolCall(String)
  case missingTool(String)
  case invalidToolState(String)
  case schemaValidationFailed(String)
  case transportFailed(String)
  case toolTimedOut(String)

  public var errorDescription: String? {
    switch self {
    case let .invalidToolDefinition(message),
         let .unknownToolCall(message),
         let .missingTool(message),
         let .invalidToolState(message),
         let .schemaValidationFailed(message),
         let .transportFailed(message),
         let .toolTimedOut(message):
      return message
    }
  }
}

enum JSONSchemaValidator {
  static func validate(_ value: JSONValue, schema: JSONSchema, label: String) throws {
    try validateValue(value, schema: schema, path: label)
  }

  private static func validateValue(_ value: JSONValue, schema: JSONSchema, path: String) throws {
    if let constant = schema["const"], constant != value {
      throw MidoClientError.schemaValidationFailed("\(path) must equal \(canonicalJSONString(constant))")
    }

    if let enumValues = schema["enum"]?.arrayValue, !enumValues.contains(value) {
      throw MidoClientError.schemaValidationFailed("\(path) is not one of the allowed enum values")
    }

    if let allowedTypes = allowedTypes(from: schema["type"]), !allowedTypes.contains(where: { matchesType(value, type: $0) }) {
      throw MidoClientError.schemaValidationFailed("\(path) must be \(allowedTypes.joined(separator: " or "))")
    }

    if let minimum = schema["minimum"]?.numberValue, let number = value.numberValue, number < minimum {
      throw MidoClientError.schemaValidationFailed("\(path) must be greater than or equal to \(minimum)")
    }

    if let maximum = schema["maximum"]?.numberValue, let number = value.numberValue, number > maximum {
      throw MidoClientError.schemaValidationFailed("\(path) must be less than or equal to \(maximum)")
    }

    if case let .object(object) = value {
      try validateObject(object, schema: schema, path: path)
    }

    if case let .array(array) = value, let itemSchema = schema["items"]?.objectValue {
      for (index, item) in array.enumerated() {
        try validateValue(item, schema: itemSchema, path: "\(path)[\(index)]")
      }
    }
  }

  private static func validateObject(_ object: JSONObject, schema: JSONSchema, path: String) throws {
    let required = schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? []
    for key in required where object[key] == nil {
      throw MidoClientError.schemaValidationFailed("\(path).\(key) is required")
    }

    let properties = schema["properties"]?.objectValue ?? [:]
    for (key, propertySchema) in properties {
      guard let value = object[key], let schema = propertySchema.objectValue else {
        continue
      }
      try validateValue(value, schema: schema, path: "\(path).\(key)")
    }

    if schema["additionalProperties"] == .bool(false) {
      let knownKeys = Set(properties.keys)
      let extraKeys = object.keys.filter { !knownKeys.contains($0) }
      if let extraKey = extraKeys.sorted().first {
        throw MidoClientError.schemaValidationFailed("\(path).\(extraKey) is not allowed")
      }
    } else if let additionalSchema = schema["additionalProperties"]?.objectValue {
      let knownKeys = Set(properties.keys)
      for key in object.keys where !knownKeys.contains(key) {
        try validateValue(object[key] ?? .null, schema: additionalSchema, path: "\(path).\(key)")
      }
    }
  }

  private static func allowedTypes(from schemaType: JSONValue?) -> [String]? {
    if let type = schemaType?.stringValue {
      return [type]
    }

    return schemaType?.arrayValue?.compactMap(\.stringValue)
  }

  private static func matchesType(_ value: JSONValue, type: String) -> Bool {
    switch (value, type) {
    case (.string, "string"),
         (.bool, "boolean"),
         (.object, "object"),
         (.array, "array"),
         (.null, "null"):
      return true
    case (.number, "number"):
      return true
    case let (.number(number), "integer"):
      return number.rounded() == number
    default:
      return false
    }
  }
}
