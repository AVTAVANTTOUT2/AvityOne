import Foundation

/// Any JSON value: the engine's configuration, administration reports and loosely typed payloads.
public enum JSONValue: Codable, Hashable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n):
      if n.rounded() == n, abs(n) < 9_007_199_254_740_992 { try c.encode(Int64(n)) } else { try c.encode(n) }
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public subscript(index: Int) -> JSONValue? {
    if case .array(let a) = self, a.indices.contains(index) { return a[index] }
    return nil
  }

  public var string: String? { if case .string(let s) = self { return s }; return nil }
  public var number: Double? { if case .number(let n) = self { return n }; return nil }
  public var int: Int? { number.map { Int($0) } }
  public var bool: Bool? {
    switch self {
    case .bool(let b): return b
    case .number(let n): return n != 0
    default: return nil
    }
  }
  public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
  public var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
  public var isNull: Bool { if case .null = self { return true }; return false }

  /// A short human rendering: strings unquoted, everything else as compact JSON.
  public var display: String {
    switch self {
    case .null: return "—"
    case .string(let s): return s
    case .bool(let b): return b ? "oui" : "non"
    case .number(let n): return n.rounded() == n ? String(Int64(n)) : String(n)
    default: return pretty(compact: true)
    }
  }

  public func pretty(compact: Bool = false) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = compact ? [.sortedKeys, .withoutEscapingSlashes] : [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "" }
    return String(decoding: data, as: UTF8.self)
  }

  public static func parse(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }

  /// Re-decodes this value as a typed model.
  public func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
  }

  public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
  ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
  public init(stringLiteral value: String) { self = .string(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last })) }
  public init(nilLiteral: ()) { self = .null }
}

public extension JSONValue {
  static func optional(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }
  static func strings(_ list: [String]) -> JSONValue { .array(list.map { .string($0) }) }
}
