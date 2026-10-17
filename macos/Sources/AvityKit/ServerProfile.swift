import Foundation

/// Where the app works: the engine embedded in the app (this Mac), or a remote AvityOne server reached by URL.
public struct ServerProfile: Codable, Hashable, Identifiable, Sendable {
  public enum Kind: String, Codable, Sendable { case local, remote }
  public var id: UUID
  public var name: String
  public var kind: Kind
  /// Remote only; the local engine's address is chosen at each launch.
  public var url: String

  public init(id: UUID = UUID(), name: String, kind: Kind, url: String = "") {
    self.id = id; self.name = name; self.kind = kind; self.url = url
  }

  public static let local = ServerProfile(id: UUID(uuidString: "00000000-0000-0000-0000-00000000A71E")!, name: "Ce Mac", kind: .local)

  public var isLocal: Bool { kind == .local }

  /// A usable base URL: http(s) with a host, without the `/api` suffix someone may paste.
  public static func normalize(_ text: String) -> URL? {
    var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
    while value.hasSuffix("/") { value.removeLast() }
    if value.hasSuffix("/api") { value.removeLast(4) }
    guard let url = URL(string: value), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else { return nil }
    return url
  }
}

/// Engine project names are `[\w.-]{1,64}` (ASCII): a folder name becomes a valid, readable project name.
public func projectName(from folder: String) -> String {
  let folded = folder.folding(options: [.diacriticInsensitive], locale: Locale(identifier: "fr_FR"))
  var name = ""
  for scalar in folded.unicodeScalars {
    if scalar.isASCII, CharacterSet.alphanumerics.contains(scalar) || scalar == "." || scalar == "_" || scalar == "-" { name.unicodeScalars.append(scalar) }
    else if !name.hasSuffix("-") { name.append("-") }
  }
  name = name.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
  return String((name.isEmpty ? "projet" : name).prefix(64))
}
