import Foundation

public struct APIError: LocalizedError, Sendable {
  public var status: Int
  public var message: String
  public init(status: Int, message: String) { self.status = status; self.message = message }
  public var errorDescription: String? { message }
}

/// HTTP client of the engine API. Bearer authentication over an ephemeral session without cookies: the server reads
/// the `avity` cookie before the header, so a stale browser cookie would otherwise win.
public final class APIClient: @unchecked Sendable {
  public let baseURL: URL
  public private(set) var token: String
  let session: URLSession

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.timeoutIntervalForRequest = 600
    configuration.timeoutIntervalForResource = 24 * 3600
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration)
  }

  public func updateToken(_ token: String) { self.token = token }

  static let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

  /// Paths only hold ids and fixed segments; query values (search text, file paths) are strictly percent-encoded.
  public func url(_ path: String, query: [String: String] = [:]) -> URL {
    var base = baseURL.absoluteString
    while base.hasSuffix("/") { base.removeLast() }
    var text = base + "/api" + path
    if !query.isEmpty {
      let encode = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: APIClient.unreserved) ?? "" }
      text += "?" + query.sorted { $0.key < $1.key }.map { "\(encode($0.key))=\(encode($0.value))" }.joined(separator: "&")
    }
    return URL(string: text)!
  }

  public func makeRequest(_ method: String, _ path: String, query: [String: String] = [:], body: JSONValue? = nil) throws -> URLRequest {
    var request = URLRequest(url: url(path, query: query))
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if method != "GET" {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONEncoder().encode(body ?? .object([:]))
    }
    return request
  }

  public func send(_ method: String, _ path: String, query: [String: String] = [:], body: JSONValue? = nil) async throws -> Data {
    let request = try makeRequest(method, path, query: query, body: body)
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let message = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["error"]?.string
      throw APIError(status: status, message: message ?? HTTPURLResponse.localizedString(forStatusCode: status))
    }
    return data
  }

  public func request<T: Decodable>(_ type: T.Type = T.self, _ method: String, _ path: String, query: [String: String] = [:], body: JSONValue? = nil) async throws -> T {
    let data = try await send(method, path, query: query, body: body)
    do { return try JSONDecoder().decode(T.self, from: data) }
    catch { throw APIError(status: 0, message: "Réponse inattendue du moteur (\(path)) : \(error)") }
  }

  public func get<T: Decodable>(_ path: String, query: [String: String] = [:], as type: T.Type = T.self) async throws -> T {
    try await request(T.self, "GET", path, query: query)
  }

  public func post<T: Decodable>(_ path: String, _ body: JSONValue = [:], as type: T.Type = T.self) async throws -> T {
    try await request(T.self, "POST", path, body: body)
  }

  @discardableResult
  public func post(_ path: String, _ body: JSONValue = [:]) async throws -> JSONValue {
    try await request(JSONValue.self, "POST", path, body: body)
  }
}

// MARK: Typed endpoints

public extension APIClient {
  func state() async throws -> AppState { try await get("/state") }
  func projects(archived: Bool = false, query: String = "") async throws -> [Project] {
    try await get("/projects", query: ["archived": archived ? "true" : "false", "q": query])
  }
  func createProject(name: String, path: String?, git: String?) async throws -> Project {
    var body: [String: JSONValue] = ["name": .string(name)]
    if let path { body["path"] = .string(path) }
    if let git { body["git"] = .string(git) }
    return try await post("/projects", .object(body))
  }
  func updateProject(_ id: Int, _ patch: JSONValue) async throws -> JSONValue { try await request(JSONValue.self, "PATCH", "/projects/\(id)", body: patch) }
  func deleteProject(_ id: Int) async throws { _ = try await send("DELETE", "/projects/\(id)") }
  func projectDocuments(_ id: Int) async throws -> ProjectDocuments { try await get("/projects/\(id)/documents") }
  func folders(_ path: String?) async throws -> FolderList { try await get("/folders", query: path.map { ["path": $0] } ?? [:]) }

  func sessions(project: Int) async throws -> [SessionRow] { try await get("/projects/\(project)/sessions") }
  func createSession(project: Int, title: String? = nil, isolated: Bool = false) async throws -> SessionRow {
    try await post("/projects/\(project)/sessions", ["title": .optional(title), "isolated": .bool(isolated)])
  }
  func snapshot(_ session: String) async throws -> Snapshot { try await get("/sessions/\(session)") }
  func updateSession(_ session: String, _ patch: JSONValue) async throws -> SessionRow { try await request(SessionRow.self, "PATCH", "/sessions/\(session)", body: patch) }
  func deleteSession(_ session: String) async throws { _ = try await send("DELETE", "/sessions/\(session)") }
  func setDraft(_ session: String, _ text: String) async throws { _ = try await send("PUT", "/sessions/\(session)/draft", body: ["text": .string(text)]) }
  func search(project: Int, query: String) async throws -> [SearchHit] { try await get("/projects/\(project)/search", query: ["q": query]) }
  func export(_ session: String) async throws -> ExportedMarkdown { try await get("/sessions/\(session)/export") }

  func uploadAttachment(session: String, name: String, mime: String, data: Data) async throws -> AttachmentRef {
    try await post("/sessions/\(session)/attachments", ["name": .string(name), "mime": .string(mime), "base64": .string(data.base64EncodedString())])
  }
  func prompt(session: String, text: String, agent: String?, mode: String?, attachments: [String], queue: Bool = false) async throws -> PromptResult {
    var body: [String: JSONValue] = ["text": .string(text), "attachments": .strings(attachments)]
    if let agent { body["agent"] = .string(agent) }
    if let mode { body["mode"] = .string(mode) }
    return try await post("/sessions/\(session)/\(queue ? "queue" : "prompt")", .object(body))
  }
  func respondPermission(session: String, permId: Int, optionId: String?) async throws {
    try await post("/sessions/\(session)/permission", ["permId": .number(Double(permId)), "optionId": .optional(optionId)])
  }
  func setConfig(session: String, configId: String, value: JSONValue) async throws -> LiveState {
    try await post("/sessions/\(session)/config", ["configId": .string(configId), "value": value])
  }
  func setAutoApprove(session: String, _ on: Bool) async throws -> LiveState { try await post("/sessions/\(session)/auto-approve", ["on": .bool(on)]) }
  func setIsolated(session: String, _ on: Bool) async throws -> LiveState { try await post("/sessions/\(session)/isolated", ["on": .bool(on)]) }
  func fork(session: String, before: Int?) async throws -> SessionRow {
    try await post("/sessions/\(session)/fork", before.map { ["before": .number(Double($0))] } ?? [:])
  }
  func edit(session: String, itemId: Int, text: String, fork: Bool) async throws -> PromptResult {
    try await post("/sessions/\(session)/edit", ["itemId": .number(Double(itemId)), "text": .string(text), "fork": .bool(fork)])
  }

  func plan(_ session: String) async throws -> Plan { try await get("/sessions/\(session)/plan") }
  func savePlan(_ session: String, _ plan: Plan) async throws -> Plan { try await request(Plan.self, "PUT", "/sessions/\(session)/plan", body: try JSONValue.from(plan)) }
  func jobs(_ session: String) async throws -> [Job] { try await get("/sessions/\(session)/jobs") }
  func mergePreview(_ session: String) async throws -> MergePreview { try await get("/sessions/\(session)/merge-preview") }
  func validations(_ session: String) async throws -> [Validation] { try await get("/sessions/\(session)/validations") }
  func findings(_ session: String) async throws -> [Finding] { try await get("/sessions/\(session)/findings") }

  func diff(_ session: String, staged: Bool) async throws -> WorkspaceDiff { try await get("/sessions/\(session)/diff", query: staged ? ["staged": "1"] : [:]) }
  func selectChange(_ session: String, path: String, hunk: Int?, action: String, revision: String, staged: Bool) async throws -> WorkspaceDiff {
    var body: [String: JSONValue] = ["path": .string(path), "action": .string(action), "revision": .string(revision), "staged": .bool(staged)]
    if let hunk { body["hunk"] = .number(Double(hunk)) }
    return try await post("/sessions/\(session)/changes", .object(body))
  }
  func gitStatus(_ session: String) async throws -> GitStatus { try await get("/sessions/\(session)/git") }
  func commit(_ session: String, message: String, all: Bool) async throws -> GitStatus { try await post("/sessions/\(session)/commit", ["message": .string(message), "all": .bool(all)]) }
  func push(_ session: String) async throws -> GitStatus { try await post("/sessions/\(session)/push", [:]) }
  func pullRequest(_ session: String, title: String, body: String) async throws -> PullRequestResult {
    try await post("/sessions/\(session)/pull-request", ["title": .string(title), "body": .string(body)])
  }

  func files(_ session: String, path: String) async throws -> FileList { try await get("/sessions/\(session)/files", query: ["path": path]) }
  func file(_ session: String, path: String) async throws -> FileContent { try await get("/sessions/\(session)/file", query: ["path": path]) }
  func saveFile(_ session: String, _ file: FileContent) async throws -> FileContent {
    try await request(FileContent.self, "PUT", "/sessions/\(session)/file", body: ["path": .string(file.path), "text": .string(file.text), "revision": .string(file.revision)])
  }
  func openTerminal(_ session: String) async throws -> String { try await post("/sessions/\(session)/terminals", [:], as: [String: String].self)["id"] ?? "" }
  func readTerminal(_ session: String, id: String, offset: Int) async throws -> TerminalRead { try await get("/sessions/\(session)/terminals/\(id)", query: ["offset": String(offset)]) }
  func writeTerminal(_ session: String, id: String, input: String) async throws { try await post("/sessions/\(session)/terminals/\(id)", ["input": .string(input)]) }
  func closeTerminal(_ session: String, id: String) async throws { _ = try await send("DELETE", "/sessions/\(session)/terminals/\(id)") }

  func agents() async throws -> [AgentEntry] { try await get("/agents") }
  func probe(agent: String) async throws -> AgentHealth { try await post("/agents/\(agent)/probe", [:]) }
  func commands(agent: String) async throws -> [AgentCommand] {
    struct Commands: Decodable { var commands: [AgentCommand] }
    return try await get("/agents/\(agent)/commands", as: Commands.self).commands
  }
  func agentOperation(agent: String, action: String) async throws -> AgentOperation { try await post("/agents/\(agent)/\(action)", [:]) }
  func operation(_ id: String) async throws -> AgentOperation { try await get("/agent-operations/\(id)") }
  func operationInput(_ id: String, input: String) async throws -> AgentOperation { try await post("/agent-operations/\(id)/input", ["input": .string(input)]) }

  func config() async throws -> JSONValue { try await get("/config") }
  func updateConfig(_ patch: JSONValue) async throws -> JSONValue { try await request(JSONValue.self, "PATCH", "/config", body: patch) }
  func administration() async throws -> JSONValue { try await get("/administration") }
  func rotateToken() async throws -> String {
    let token = try await post("/token/rotate", [:], as: [String: String].self)["token"] ?? ""
    updateToken(token)
    return token
  }

  func knowledge(project: Int, query: String) async throws -> KnowledgeList { try await get("/projects/\(project)/memory", query: query.isEmpty ? [:] : ["q": query]) }
  func addMemory(project: Int, kind: String, text: String) async throws { try await post("/projects/\(project)/memory", ["kind": .string(kind), "text": .string(text)]) }
  func deleteMemory(project: Int, id: Int) async throws { _ = try await send("DELETE", "/projects/\(project)/memory/\(id)") }
  func contextPack(_ session: String, query: String) async throws -> ContextPack { try await get("/sessions/\(session)/context", query: ["q": query]) }
  func contextSelection(_ session: String) async throws -> ContextSelection { try await get("/sessions/\(session)/context-selection") }
  func setContextSelection(_ session: String, _ selection: ContextSelection) async throws -> ContextSelection {
    try await request(ContextSelection.self, "PATCH", "/sessions/\(session)/context-selection", body: try JSONValue.from(selection))
  }
  func transcribe(audio: Data, mime: String, language: String) async throws -> String {
    try await post("/transcribe", ["base64": .string(audio.base64EncodedString()), "mime": .string(mime), "language": .string(language)], as: Transcription.self).text
  }
}
