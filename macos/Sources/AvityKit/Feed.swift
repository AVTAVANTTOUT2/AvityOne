import Foundation

/// The items of one session, kept in id order. SSE `item` events always carry the whole item: upsert by id.
public struct Feed: Sendable {
  public private(set) var items: [Item] = []

  public init(items: [Item] = []) { self.items = items.sorted { $0.id < $1.id } }

  public mutating func upsert(_ item: Item) {
    // Streaming touches the tail: search from the end.
    if let index = items.lastIndex(where: { $0.id == item.id }) { items[index] = item; return }
    if let last = items.last, last.id > item.id {
      let at = items.firstIndex { $0.id > item.id } ?? items.endIndex
      items.insert(item, at: at)
    } else {
      items.append(item)
    }
  }

  /// Edit and regenerate cut the conversation: every item from `fromId` on disappears.
  public mutating func reset(from id: Int) { items.removeAll { $0.id >= id } }

  public var lastUserIndex: Int? { items.lastIndex { $0.itemType == .user } }

  /// For each finished turn (keyed by its `end` item): the answer text to copy and the next user item, where a fork
  /// of that turn stops. `retry` is the error ending an unanswered turn.
  public func turns() -> (turns: [Int: Turn], retry: Int?) {
    var turns: [Int: Turn] = [:]
    var texts: [String] = []
    var open: [Int] = []
    var answered = true
    for item in items {
      switch item.itemType {
      case .user:
        for id in open { turns[id]?.before = item.id }
        open = []; texts = []; answered = false
      case .assistant:
        if let text = item.text, !text.isEmpty { texts.append(text) }
      case .end:
        turns[item.id] = Turn(copy: texts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines), before: nil)
        open.append(item.id); answered = true
      default: break
      }
    }
    let retry = !answered && items.last?.itemType == .error ? items.last?.id : nil
    return (turns, retry)
  }

  public struct Turn: Hashable, Sendable { public var copy: String; public var before: Int? }

  /// What the agent is doing now, from the tail of the feed (only meaningful while the session is busy).
  public func activityLabel() -> String {
    for item in items.reversed() {
      switch item.itemType {
      case .user: return "charge le contexte"
      case .permission where item.resolved == nil: return "attend ta validation"
      case .tool where item.isOpenTool: return Feed.verb(for: item)
      case .assistant: return "rédige"
      case .thought: return "réfléchit"
      case .plan: return "planifie"
      case .tool: return "enchaîne"
      default: continue
      }
    }
    return "démarre"
  }

  public static func verb(for item: Item) -> String {
    let target = item.paths?.first.map { " " + ($0.split(separator: "/").last.map(String.init) ?? $0) } ?? ""
    switch item.kind {
    case "read": return "lit\(target)"
    case "search": return "cherche\(target)"
    case "edit": return "modifie\(target)"
    case "delete": return "supprime\(target)"
    case "move": return "déplace\(target)"
    case "execute": return "exécute\(item.command.map { " " + $0.prefix(40) } ?? "")"
    case "fetch": return "consulte\(target)"
    case "think": return "réfléchit"
    default: return "utilise \(item.title ?? "un outil")"
    }
  }

  /// The agent of each item: tool, plan and permission items belong to the agent of the preceding user message.
  public func agent(at index: Int) -> String? {
    if let agent = items[index].agent { return agent }
    for item in items[..<index].reversed() where item.itemType == .user { return item.agent }
    return nil
  }
}

/// Activity of a session seen from the sidebar: live state plus a finished turn not seen yet.
public struct SessionActivity: Hashable, Sendable {
  public enum Unread: String, Sendable { case done, error }
  public var projectId: Int
  public var busy = false
  public var waiting = false
  public var unread: Unread?
  public init(projectId: Int, busy: Bool = false, waiting: Bool = false, unread: Unread? = nil) {
    self.projectId = projectId; self.busy = busy; self.waiting = waiting; self.unread = unread
  }

  public enum Signal: Int, Comparable, Sendable {
    case done = 1, error, busy, waiting
    public static func < (a: Signal, b: Signal) -> Bool { a.rawValue < b.rawValue }
    public var label: String {
      switch self {
      case .waiting: return "attend ta validation"
      case .busy: return "en cours"
      case .error: return "échec pas encore vu"
      case .done: return "terminé, pas encore vu"
      }
    }
  }

  public var signal: Signal? {
    if waiting { return .waiting }
    if busy { return .busy }
    switch unread { case .error: return .error; case .done: return .done; case nil: return nil }
  }
}
