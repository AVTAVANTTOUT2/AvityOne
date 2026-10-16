import XCTest
@testable import AvityKit

/// AvityKit against the real engine (src/server.ts) and the scripted ACP agent of test/fake-agent.mjs.
/// Runs when AVITY_ENGINE_TEST=1 (CI), with Node 24 from AVITY_NODE or PATH.
final class EngineIntegrationTests: XCTestCase {
  final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [ServerEvent] = []
    private var links: [EventStream.Link] = []
    func add(_ event: ServerEvent) { lock.lock(); events.append(event); lock.unlock() }
    func add(_ link: EventStream.Link) { lock.lock(); links.append(link); lock.unlock() }
    var items: [Item] {
      lock.lock(); defer { lock.unlock() }
      return events.compactMap { if case .item(_, _, let item) = $0 { return item }; return nil }
    }
    var activities: [ActivityEvent] {
      lock.lock(); defer { lock.unlock() }
      return events.compactMap { if case .activity(let a) = $0 { return a }; return nil }
    }
    var opened: Bool { lock.lock(); defer { lock.unlock() }; return links.contains(.open) }
  }

  final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ chunk: Data) { lock.lock(); data.append(chunk); lock.unlock() }
    var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
  }

  static var repository: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  }

  static func node() -> String? {
    if let path = ProcessInfo.processInfo.environment["AVITY_NODE"] { return path }
    for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") {
      let candidate = "\(dir)/node"
      if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
  }

  func waitUntil(_ what: String, timeout: TimeInterval = 20, _ condition: () async throws -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if try await condition() { return }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTFail("délai dépassé : \(what)")
    throw APIError(status: 0, message: what)
  }

  func testPromptPermissionAndEventsAgainstTheRealEngine() async throws {
    guard ProcessInfo.processInfo.environment["AVITY_ENGINE_TEST"] == "1" else { throw XCTSkip("AVITY_ENGINE_TEST=1 pour lancer le moteur réel") }
    let node = try XCTUnwrap(Self.node(), "Node 24 introuvable")
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("avity-swift-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    let agent = Self.repository.appendingPathComponent("test/fake-agent.mjs").path
    var fake: [String: JSONValue] = [:]
    fake["name"] = "Fake"
    fake["cmd"] = .string(node)
    fake["args"] = .strings([agent])
    fake["strengths"] = ""
    var config: [String: JSONValue] = [:]
    config["token"] = "swift"
    config["projectsDir"] = .string(home.appendingPathComponent("projects").path)
    config["defaultAgent"] = "fake"
    config["routing"] = .object(["fallback": .bool(false)])
    config["reviewer"] = .object(["fake": .string("fake")])
    config["summarizer"] = .object(["agent": .string("fake")])
    config["agents"] = .object(["fake": .object(fake)])
    try Data(JSONValue.object(config).pretty().utf8).write(to: home.appendingPathComponent("config.json"))
    let port = try XCTUnwrap(bindableLoopbackPort())

    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [Self.repository.appendingPathComponent("src/server.ts").path]
    var environment = ProcessInfo.processInfo.environment
    environment["AVITY_HOME"] = home.path
    environment["AVITY_HOST"] = "127.0.0.1"
    environment["AVITY_PORT"] = String(port)
    environment["AVITY_EMBEDDED"] = "1"
    environment["NODE_NO_WARNINGS"] = "1"
    process.environment = environment
    let stdin = Pipe(), stdout = Pipe()
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = stdout
    let log = Log()
    stdout.fileHandleForReading.readabilityHandler = { log.append($0.availableData) }
    try process.run()
    defer {
      if process.isRunning { process.terminate() }
      stdout.fileHandleForReading.readabilityHandler = nil
      print("— journal du moteur —\n\(log.text)")
    }

    let client = APIClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: "swift")
    try await waitUntil("démarrage du moteur") { (try? await client.state()) != nil }

    let unauthorized = APIClient(baseURL: client.baseURL, token: "faux")
    do { _ = try await unauthorized.state(); XCTFail("jeton refusé attendu") } catch let error as APIError { XCTAssertEqual(error.status, 401) }

    let state = try await client.state()
    XCTAssertEqual(state.agents.first { $0.id == "fake" }?.installed, true)
    let project = try XCTUnwrap(state.projects.first, "projet par défaut")

    let collector = Collector()
    let stream = EventStream(client: client, onEvent: { collector.add($0) }, onLink: { collector.add($0) }, onReconnect: {})
    stream.start()
    defer { stream.stop() }
    try await waitUntil("ouverture du flux") { collector.opened }

    let session = try await client.createSession(project: project.id)
    let manual = try await client.setAutoApprove(session: session.id, false)
    XCTAssertFalse(manual.autoApprove)
    let result = try await client.prompt(session: session.id, text: "bonjour", agent: "fake", mode: nil, attachments: [])
    XCTAssertEqual(result.status, "queued")

    try await waitUntil("demande d’autorisation") { collector.items.contains { $0.isPendingPermission } }
    let permission = try XCTUnwrap(collector.items.last { $0.isPendingPermission })
    XCTAssertTrue(collector.activities.contains { $0.kind == "waiting" && $0.sessionId == session.id })
    let allow = try XCTUnwrap(permission.options?.first { $0.isAllow })
    try await client.respondPermission(session: session.id, permId: permission.id, optionId: allow.id)
    try await waitUntil("fin du tour") { collector.items.contains { $0.itemType == .end } }

    let snapshot = try await client.snapshot(session.id)
    let types = Set(snapshot.items.map(\.itemType))
    XCTAssertTrue(types.isSuperset(of: [.user, .assistant, .tool, .permission, .plan, .end]), "\(types)")
    XCTAssertEqual(snapshot.items.first { $0.itemType == .permission }?.resolved, allow.name)
    XCTAssertTrue(snapshot.items.contains { $0.itemType == .assistant && ($0.text ?? "").contains("mode=") })
    var feed = Feed(items: [])
    for item in collector.items where snapshot.items.contains(where: { $0.id == item.id }) { feed.upsert(item) }
    XCTAssertEqual(feed.items.map(\.id), snapshot.items.map(\.id), "streamed items rebuild the snapshot")
    XCTAssertTrue(collector.activities.contains { $0.kind == "done" && $0.sessionId == session.id })

    do { _ = try await client.gitStatus(session.id); XCTFail("projet sans git") } catch let error as APIError { XCTAssertEqual(error.status, 409) }
    let renamed = try await client.updateSession(session.id, ["title": "Fil Swift", "pinned": true])
    XCTAssertEqual(renamed.title, "Fil Swift")
    XCTAssertTrue(renamed.pinned)
    let exported = try await client.export(session.id)
    XCTAssertTrue(exported.markdown.contains("bonjour"))

    // Closing stdin, as the app does when it quits or crashes, stops the engine.
    try stdin.fileHandleForWriting.close()
    try await waitUntil("arrêt du moteur", timeout: 10) { !process.isRunning }
    XCTAssertEqual(process.terminationStatus, 0)
  }
}
