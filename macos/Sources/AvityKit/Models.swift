import Foundation

// Models of the engine's HTTP+SSE contract (src/server.ts, src/hub.ts). SQLite columns arrive as 0/1 integers,
// live fields as booleans: `flexBool` reads both. Missing fields fall back to neutral values so a newer engine
// never breaks an older app.

extension KeyedDecodingContainer {
  func flexBool(_ key: Key, _ fallback: Bool = false) -> Bool {
    if let b = try? decodeIfPresent(Bool.self, forKey: key) { return b }
    if let n = try? decodeIfPresent(Int.self, forKey: key) { return n != 0 }
    return fallback
  }
  func value<T: Decodable>(_ key: Key, _ fallback: T) -> T { (try? decodeIfPresent(T.self, forKey: key)) ?? fallback }
  func optional<T: Decodable>(_ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
}

/// SQLite `CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS", UTC) or ISO 8601.
public func parseServerDate(_ text: String?) -> Date? {
  guard let text, !text.isEmpty else { return nil }
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = iso.date(from: text) { return d }
  iso.formatOptions = [.withInternetDateTime]
  if let d = iso.date(from: text) { return d }
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = TimeZone(identifier: "UTC")
  f.dateFormat = "yyyy-MM-dd HH:mm:ss"
  return f.date(from: text)
}

public struct Project: Codable, Identifiable, Hashable, Sendable {
  public var id: Int
  public var name: String
  public var path: String
  public var createdAt: String?
  public var archived: Bool

  enum CodingKeys: String, CodingKey { case id, name, path, createdAt = "created_at", archived }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    name = c.value(.name, "")
    path = c.value(.path, "")
    createdAt = c.optional(.createdAt)
    archived = c.flexBool(.archived)
  }
}

public struct AgentSummary: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var strengths: String
  public var installed: Bool
}

public struct LiveActivity: Codable, Hashable, Sendable {
  public var sessionId: String
  public var projectId: Int
  public var busy: Bool
  public var waiting: Bool
}

public struct AppState: Codable, Sendable {
  public var agents: [AgentSummary]
  public var projects: [Project]
  public var activity: [LiveActivity]
}

public struct SessionRow: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  public var projectId: Int?
  public var title: String?
  public var agent: String?
  public var mode: String
  public var turns: Int
  public var summary: String?
  public var parentId: String?
  public var forkedFrom: String?
  public var pinned: Bool
  public var archived: Bool
  public var isolated: Bool
  public var worktree: String?
  public var draft: String?
  public var updatedAt: String
  public var busy: Bool
  public var waiting: Bool

  enum CodingKeys: String, CodingKey {
    case id, title, agent, mode, turns, summary, pinned, archived, isolated, worktree, draft, busy, waiting
    case projectId = "project_id", parentId = "parent_id", forkedFrom = "forked_from", updatedAt = "updated_at"
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    projectId = c.optional(.projectId)
    title = c.optional(.title)
    agent = c.optional(.agent)
    mode = c.value(.mode, "agent")
    turns = c.value(.turns, 0)
    summary = c.optional(.summary)
    parentId = c.optional(.parentId)
    forkedFrom = c.optional(.forkedFrom)
    pinned = c.flexBool(.pinned)
    archived = c.flexBool(.archived)
    isolated = c.flexBool(.isolated)
    worktree = c.optional(.worktree)
    draft = c.optional(.draft)
    updatedAt = c.value(.updatedAt, "")
    busy = c.flexBool(.busy)
    waiting = c.flexBool(.waiting)
  }

  public var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "Nouveau fil" }
}

/// One choice of an ACP session config option; groups are flattened, keeping their name.
public struct ConfigChoice: Hashable, Sendable, Identifiable {
  public var value: JSONValue
  public var name: String
  public var group: String?
  public var id: String { value.display }
}

public struct ConfigOption: Codable, Identifiable, Hashable, Sendable {
  public var id: String
  public var name: String
  public var type: String
  public var category: String?
  public var currentValue: JSONValue?
  public var options: [JSONValue]

  enum CodingKeys: String, CodingKey { case id, name, type, category, currentValue, options }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = c.value(.name, id)
    type = c.value(.type, "select")
    category = c.optional(.category)
    currentValue = c.optional(.currentValue)
    options = c.value(.options, [])
  }

  public var choices: [ConfigChoice] {
    func flatten(_ list: [JSONValue], group: String?) -> [ConfigChoice] {
      list.flatMap { entry -> [ConfigChoice] in
        if let nested = entry["options"]?.array { return flatten(nested, group: entry["name"]?.string ?? group) }
        guard let value = entry["value"] ?? entry["id"] else { return [] }
        return [ConfigChoice(value: value, name: entry["name"]?.string ?? value.display, group: group)]
      }
    }
    return flatten(options, group: nil)
  }

  public var currentName: String {
    guard let currentValue else { return "—" }
    return choices.first { $0.value == currentValue }?.name ?? currentValue.display
  }
}

public struct AgentMode: Codable, Hashable, Sendable { public var id: String; public var name: String }

public struct AgentCommand: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var description: String
  public var hint: String?
  public var id: String { name }

  enum CodingKeys: String, CodingKey { case name, description, input }
  enum InputKeys: String, CodingKey { case hint }
  public init(name: String, description: String, hint: String? = nil) { self.name = name; self.description = description; self.hint = hint }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    description = c.value(.description, "")
    hint = (try? c.nestedContainer(keyedBy: InputKeys.self, forKey: .input))?.optional(.hint)
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(name, forKey: .name)
    try c.encode(description, forKey: .description)
  }
}

public struct LiveState: Codable, Hashable, Sendable {
  public var busy = false
  public var waiting = false
  public var agent: String?
  public var mode = "agent"
  public var autoApprove = true
  public var connected = false
  public var isolated = false
  public var worktree: String?
  public var modeId: String?
  public var modes: [AgentMode] = []
  public var configOptions: [ConfigOption] = []
  public var commands: [AgentCommand] = []
  public var queued = 0

  public init() {}
  enum CodingKeys: String, CodingKey { case busy, waiting, agent, mode, autoApprove, connected, isolated, worktree, modeId, modes, configOptions, commands, queued }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    busy = c.flexBool(.busy)
    waiting = c.flexBool(.waiting)
    agent = c.optional(.agent)
    mode = c.value(.mode, "agent")
    autoApprove = c.flexBool(.autoApprove, true)
    connected = c.flexBool(.connected)
    isolated = c.flexBool(.isolated)
    worktree = c.optional(.worktree)
    modeId = c.optional(.modeId)
    modes = c.value(.modes, [])
    configOptions = c.value(.configOptions, [])
    commands = c.value(.commands, [])
    queued = c.value(.queued, 0)
  }

  /// Model, effort and other agent selectors; the agent's own mode stays managed by AvityOne's plan/agent switch.
  public var selectors: [ConfigOption] { configOptions.filter { $0.type == "select" && $0.category != "mode" } }
}

public struct ContentResource: Codable, Hashable, Sendable {
  public var uri: String?
  public var mimeType: String?
  public var text: String?
  public var blob: String?
}

/// An ACP content block: text, image, audio, embedded resource or resource link.
public struct ContentBlock: Codable, Hashable, Sendable {
  public var type: String
  public var text: String?
  public var mimeType: String?
  public var data: String?
  public var uri: String?
  public var name: String?
  public var resource: ContentResource?
}

public struct AttachmentRef: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var mime: String
  public var size: Int
}

public struct ToolDiff: Codable, Hashable, Sendable {
  public var path: String
  public var old: String?
  public var new: String?
}

public struct PlanEntry: Codable, Hashable, Sendable {
  public var content: String
  public var priority: String?
  public var status: String
}

public struct PermissionOption: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var kind: String
  public var isAllow: Bool { kind.hasPrefix("allow") }
}

public struct ParallelChild: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var task: String
  public var agent: String?
  public var status: String
  public var taskId: String?
  public var dependencies: [String]?
  public var files: [String]?
  public var conflicts: [String]?
}

public enum ItemType: String, Sendable {
  case user, assistant, thought, tool, plan, permission, end, error, info, review, parallel, unknown
}

/// One entry of a session feed. All payload fields are optional: each `type` uses its own subset.
public struct Item: Codable, Identifiable, Hashable, Sendable {
  public var id: Int
  public var type: String
  public var text: String?
  public var agent: String?
  public var mode: String?
  public var reason: String?
  public var edited: Bool?
  public var regenerated: Bool?
  public var content: [ContentBlock]?
  public var attachments: [AttachmentRef]?
  public var toolCallId: String?
  public var title: String?
  public var status: String?
  public var kind: String?
  public var paths: [String]?
  public var command: String?
  public var diffs: [ToolDiff]?
  public var output: String?
  public var entries: [PlanEntry]?
  public var options: [PermissionOption]?
  public var resolved: String?
  public var stopReason: String?
  public var level: String?
  public var approved: Bool?
  public var fingerprint: String?
  public var children: [ParallelChild]?

  public init(id: Int, type: String, text: String? = nil) { self.id = id; self.type = type; self.text = text }

  enum CodingKeys: String, CodingKey {
    case id, type, text, agent, mode, reason, edited, regenerated, content, attachments, toolCallId, title, status, kind, paths
    case command, diffs, output, entries, options, resolved, stopReason, level, approved, fingerprint, children
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    type = c.value(.type, "unknown")
    text = c.optional(.text)
    agent = c.optional(.agent)
    mode = c.optional(.mode)
    reason = c.optional(.reason)
    edited = c.optional(.edited)
    regenerated = c.optional(.regenerated)
    content = c.optional(.content)
    attachments = c.optional(.attachments)
    toolCallId = c.optional(.toolCallId)
    title = c.optional(.title)
    status = c.optional(.status)
    kind = c.optional(.kind)
    paths = c.optional(.paths)
    command = c.optional(.command)
    diffs = c.optional(.diffs)
    output = c.optional(.output)
    entries = c.optional(.entries)
    options = c.optional(.options)
    resolved = c.optional(.resolved)
    stopReason = c.optional(.stopReason)
    level = c.optional(.level)
    approved = c.optional(.approved)
    fingerprint = c.optional(.fingerprint)
    children = c.optional(.children)
  }

  public var itemType: ItemType { ItemType(rawValue: type) ?? .unknown }
  public var isOpenTool: Bool { itemType == .tool && (status == "pending" || status == "in_progress") }
  public var isPendingPermission: Bool { itemType == .permission && resolved == nil && !(options ?? []).isEmpty }
}

public struct Snapshot: Codable, Sendable {
  public var session: SessionRow
  public var state: LiveState
  public var items: [Item]
}

public struct ActivityEvent: Codable, Hashable, Sendable {
  public var sessionId: String
  public var projectId: Int
  public var kind: String
  public var title: String?
  public var agent: String?
  public var text: String
}

/// One message of `/api/events`.
public enum ServerEvent: Sendable {
  case item(sessionId: String, projectId: Int, item: Item)
  case state(sessionId: String, projectId: Int, state: LiveState)
  case activity(ActivityEvent)
  case sessions(projectId: Int)
  case reset(sessionId: String, projectId: Int, fromId: Int)
  case plan(sessionId: String, plan: Plan)
  case validation(sessionId: String, payload: JSONValue)
  case unknown(String)

  public static func decode(_ data: Data) throws -> ServerEvent {
    struct Head: Decodable { var type: String; var sessionId: String?; var projectId: Int?; var fromId: Int? }
    struct ItemEvent: Decodable { var item: Item }
    struct StateEvent: Decodable { var state: LiveState }
    struct PlanEvent: Decodable { var plan: Plan }
    let decoder = JSONDecoder()
    let head = try decoder.decode(Head.self, from: data)
    let sid = head.sessionId ?? "", pid = head.projectId ?? 0
    switch head.type {
    case "item": return .item(sessionId: sid, projectId: pid, item: try decoder.decode(ItemEvent.self, from: data).item)
    case "state": return .state(sessionId: sid, projectId: pid, state: try decoder.decode(StateEvent.self, from: data).state)
    case "activity": return .activity(try decoder.decode(ActivityEvent.self, from: data))
    case "sessions": return .sessions(projectId: pid)
    case "reset": return .reset(sessionId: sid, projectId: pid, fromId: head.fromId ?? 0)
    case "plan": return .plan(sessionId: sid, plan: try decoder.decode(PlanEvent.self, from: data).plan)
    case "validation": return .validation(sessionId: sid, payload: try decoder.decode(JSONValue.self, from: data))
    default: return .unknown(head.type)
    }
  }
}

public struct PromptResult: Codable, Sendable {
  public var agent: String?
  public var mode: String?
  public var reason: String?
  public var jobId: Int?
  public var status: String?
  public var sessionId: String?
}

public struct SearchHit: Codable, Hashable, Sendable, Identifiable {
  public var sessionId: String
  public var title: String?
  public var agent: String?
  public var itemId: Int
  public var snippet: String
  public var hits: Int
  public var id: String { "\(sessionId)#\(itemId)" }

  enum CodingKeys: String, CodingKey { case sessionId = "session_id", title, agent, itemId = "item_id", snippet, hits }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sessionId = try c.decode(String.self, forKey: .sessionId)
    title = c.optional(.title)
    agent = c.optional(.agent)
    itemId = c.value(.itemId, 0)
    snippet = c.value(.snippet, "")
    hits = c.value(.hits, 1)
  }

  /// The snippet without the \u{2} … \u{3} match markers.
  public var plainSnippet: String { snippet.replacingOccurrences(of: "\u{2}", with: "").replacingOccurrences(of: "\u{3}", with: "") }
}

// MARK: Plans and orchestration

public struct PlanTask: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var content: String
  public var dependencies: [String]
  public var files: [String]
  public var selected: Bool
  public var agent: String?

  public init(id: String, content: String, dependencies: [String] = [], files: [String] = [], selected: Bool = true, agent: String? = nil) {
    self.id = id; self.content = content; self.dependencies = dependencies; self.files = files; self.selected = selected; self.agent = agent
  }
}

public struct Plan: Codable, Hashable, Sendable {
  public var specification: String
  public var tasks: [PlanTask]
  public var revision: Int
}

public struct Job: Codable, Hashable, Sendable, Identifiable {
  public var id: Int
  public var sessionId: String
  public var parentId: String?
  public var taskId: String?
  public var prompt: String
  public var status: String
  public var attempts: Int
  public var error: String?
  public var result: JSONValue?
  public var updatedAt: String?

  enum CodingKeys: String, CodingKey { case id, sessionId = "session_id", parentId = "parent_id", taskId = "task_id", prompt, status, attempts, error, result, updatedAt = "updated_at" }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    sessionId = c.value(.sessionId, "")
    parentId = c.optional(.parentId)
    taskId = c.optional(.taskId)
    prompt = c.value(.prompt, "")
    status = c.value(.status, "queued")
    attempts = c.value(.attempts, 0)
    error = c.optional(.error)
    result = c.optional(.result)
    updatedAt = c.optional(.updatedAt)
  }
  public var canRetry: Bool { ["error", "interrupted", "cancelled"].contains(status) }
}

public struct Validation: Codable, Hashable, Sendable, Identifiable {
  public var id: Int
  public var command: String
  public var status: String
  public var output: String?
  public var createdAt: String?
  enum CodingKeys: String, CodingKey { case id, command, status, output, createdAt = "created_at" }
}

public struct ValidationRun: Codable, Sendable {
  public var ok: Bool
  public var results: [Validation]
}

public struct Finding: Codable, Hashable, Sendable, Identifiable {
  public var id: Int
  public var agent: String
  public var path: String
  public var message: String
  public var status: String
  public var resolution: String
}

public struct Hunk: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var path: String
  public var patch: String
}

public struct MergeBranch: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var branch: String
  public var files: [String]
  public var hunks: [Hunk]
}

public struct MergePreview: Codable, Sendable {
  public var branches: [MergeBranch]
  public var fingerprint: String
}

public struct MergeResult: Codable, Sendable {
  public var merged: Int
  public var failed: Int
  public var conflicts: [String]?
}

// MARK: Workspace and git

public struct WorkspaceDiff: Codable, Sendable {
  public var diff: String
  public var files: [String]
  public var untracked: [String]
  public var hunks: [Hunk]
  public var revision: String
  public var staged: Bool

  enum CodingKeys: String, CodingKey { case diff, files, untracked, hunks, revision, staged }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    diff = c.value(.diff, "")
    files = c.value(.files, [])
    untracked = c.value(.untracked, [])
    hunks = c.value(.hunks, [])
    revision = c.value(.revision, "")
    staged = c.flexBool(.staged)
  }
}

public struct GitStatus: Codable, Hashable, Sendable {
  public var branch: String?
  public var head: String?
  public var upstream: String?
  public var ahead: Int
  public var behind: Int
  public var remote: String?
  public var clean: Bool
  public var github: Bool
  public var output: String?
}

public struct PullRequestResult: Codable, Sendable { public var url: String?; public var output: String }

public struct FileEntry: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var directory: Bool
  public var symlink: Bool
  public var path: String
  public var id: String { path }
}

public struct FileList: Codable, Sendable { public var path: String; public var entries: [FileEntry] }
public struct FileContent: Codable, Hashable, Sendable { public var path: String; public var text: String; public var revision: String }

public struct TerminalRead: Codable, Sendable {
  public var output: String
  public var offset: Int
  public var truncated: Bool
  public var closed: Bool
  public var exit: Int?
}

public struct FolderList: Codable, Sendable {
  public struct Folder: Codable, Hashable, Sendable, Identifiable { public var name: String; public var path: String; public var id: String { path } }
  public var path: String
  public var parent: String
  public var folders: [Folder]
}

// MARK: Agents and administration

public struct QuotaSnapshot: Codable, Hashable, Sendable {
  public var status: String
  public var remaining: Double?
  public var limit: Double?
  public var unit: String?
  public var resetAt: String?
  public var checkedAt: String?
  public var error: String?
  public var details: String?
}

public struct AgentHealth: Codable, Hashable, Sendable {
  public var status: String
  public var authentication: String
  public var quota: String?
  public var quotaSnapshot: QuotaSnapshot?
  public var checkedAt: String?
  public var latencyMs: Double?
  public var error: String?

  enum CodingKeys: String, CodingKey { case status, authentication, quota, quotaSnapshot, checkedAt, latencyMs, error }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    status = c.value(.status, "unknown")
    authentication = c.value(.authentication, "unknown")
    quota = c.optional(.quota)
    quotaSnapshot = c.optional(.quotaSnapshot)
    checkedAt = c.optional(.checkedAt)
    latencyMs = c.optional(.latencyMs)
    error = c.optional(.error)
  }
}

public struct AgentCatalogInfo: Codable, Hashable, Sendable {
  public var packages: [String]
  public var command: String
  public var docs: String?
  public var commandInstalled: Bool
  public var loginCommand: [String]

  enum CodingKeys: String, CodingKey { case packages, command, docs, commandInstalled, loginCommand, login }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    packages = c.value(.packages, [])
    command = c.value(.command, "")
    docs = c.optional(.docs)
    commandInstalled = c.flexBool(.commandInstalled, true)
    let login: [String] = c.value(.login, [])
    loginCommand = c.value(.loginCommand, [command] + login)
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(packages, forKey: .packages); try c.encode(command, forKey: .command)
    try c.encode(commandInstalled, forKey: .commandInstalled); try c.encode(loginCommand, forKey: .loginCommand)
  }
}

public struct AgentEntry: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var strengths: String
  public var installed: Bool
  public var catalog: AgentCatalogInfo?
  public var health: AgentHealth?
}

public struct AgentOperation: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var agent: String
  public var action: String
  public var state: String
  public var output: String
  public var exitCode: Int?
  public var running: Bool { state == "running" }
}

public struct ProjectDocuments: Codable, Sendable { public var brief: String; public var instructions: String }

public struct Memory: Codable, Hashable, Sendable, Identifiable {
  public var id: Int
  public var kind: String
  public var text: String
  public var subject: String?
  public var predicate: String?
  public var object: String?
  public var validUntil: String?
  public var stale: Bool
  public var contradictions: [Int]

  enum CodingKeys: String, CodingKey { case id, kind, text, subject, predicate, object, validUntil = "valid_until", stale, contradictions }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    kind = c.value(.kind, "fact")
    text = c.value(.text, "")
    subject = c.optional(.subject)
    predicate = c.optional(.predicate)
    object = c.optional(.object)
    validUntil = c.optional(.validUntil)
    stale = c.flexBool(.stale)
    contradictions = c.value(.contradictions, [])
  }
}

public struct KnowledgeDoc: Codable, Hashable, Sendable, Identifiable {
  public var path: String
  public var text: String?
  public var characters: Int?
  public var id: String { path }
}

public struct KnowledgeList: Codable, Sendable {
  public var memory: [Memory]
  public var docs: [KnowledgeDoc]
  public var kbChunks: Int
}

public struct ContextPack: Codable, Sendable { public var text: String; public var stats: String; public var warnings: [String] }

public struct ContextSelection: Codable, Hashable, Sendable {
  public var memoryIds: [Int]?
  public var paths: [String]?
  public var custom: String?
  public var includeBrief: Bool?
  public var includeInstructions: Bool?
  public var includeGit: Bool?
  public var includeRecent: Bool?
  public init() {}
}

public struct ExportedMarkdown: Codable, Sendable { public var filename: String; public var markdown: String }
public struct Transcription: Codable, Sendable { public var text: String }
public struct OK: Codable, Sendable { public var ok: Bool? }
