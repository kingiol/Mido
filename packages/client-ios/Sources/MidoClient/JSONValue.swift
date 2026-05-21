import Foundation

public typealias JSONObject = [String: JSONValue]
public typealias JSONSchema = JSONObject

public enum JSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object(JSONObject)
  case array([JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()

    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Int.self) {
      self = .number(Double(value))
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode(JSONObject.self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case let .string(value):
      try container.encode(value)
    case let .number(value):
      try container.encode(value)
    case let .bool(value):
      try container.encode(value)
    case let .object(value):
      try container.encode(value)
    case let .array(value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) {
    self = .string(value)
  }
}

extension JSONValue: ExpressibleByIntegerLiteral {
  public init(integerLiteral value: Int) {
    self = .number(Double(value))
  }
}

extension JSONValue: ExpressibleByFloatLiteral {
  public init(floatLiteral value: Double) {
    self = .number(value)
  }
}

extension JSONValue: ExpressibleByBooleanLiteral {
  public init(booleanLiteral value: Bool) {
    self = .bool(value)
  }
}

extension JSONValue: ExpressibleByNilLiteral {
  public init(nilLiteral: ()) {
    self = .null
  }
}

extension JSONValue: ExpressibleByArrayLiteral {
  public init(arrayLiteral elements: JSONValue...) {
    self = .array(elements)
  }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(uniqueKeysWithValues: elements))
  }
}

public extension JSONValue {
  var objectValue: JSONObject? {
    if case let .object(value) = self {
      return value
    }
    return nil
  }

  var arrayValue: [JSONValue]? {
    if case let .array(value) = self {
      return value
    }
    return nil
  }

  var stringValue: String? {
    if case let .string(value) = self {
      return value
    }
    return nil
  }

  var numberValue: Double? {
    if case let .number(value) = self {
      return value
    }
    return nil
  }

  var boolValue: Bool? {
    if case let .bool(value) = self {
      return value
    }
    return nil
  }
}

public extension JSONEncoder {
  static var mido: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

public extension JSONDecoder {
  static var mido: JSONDecoder {
    JSONDecoder()
  }
}

func canonicalJSONString(_ value: JSONValue) -> String {
  switch value {
  case let .string(value):
    return encodeJSONString(value)
  case let .number(value):
    if value.rounded() == value {
      return String(Int64(value))
    }
    return String(value)
  case let .bool(value):
    return value ? "true" : "false"
  case .null:
    return "null"
  case let .array(values):
    return "[\(values.map(canonicalJSONString).joined(separator: ","))]"
  case let .object(value):
    return "{\(value.keys.sorted().map { "\(encodeJSONString($0)):\(canonicalJSONString(value[$0] ?? .null))" }.joined(separator: ","))}"
  }
}

private func encodeJSONString(_ value: String) -> String {
  guard
    let data = try? JSONEncoder().encode(value),
    let encoded = String(data: data, encoding: .utf8)
  else {
    return "\"\""
  }
  return encoded
}
