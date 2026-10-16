import Foundation
import Security
import AvityKit

/// The AvityOne engine (src/server.ts) embedded in the app and run by the bundled Node 24, on 127.0.0.1 only.
/// The app keeps the engine's stdin: when the app quits or crashes, the pipe closes and the engine stops with its
/// agents (AVITY_EMBEDDED=1), as systemd's cleanup did on the servers.
final class EngineController: @unchecked Sendable {
  struct Endpoint: Sendable, Equatable { var url: URL; var token: String; var port: Int }

  enum Failure: LocalizedError {
    case missingBundle(String), exited(String), timeout(String), configuration(String)
    var errorDescription: String? {
      switch self {
      case .missingBundle(let path): return "Moteur introuvable dans l’application (\(path)). Reconstruis AvityOne.app avec macos/scripts/build-app.sh."
      case .exited(let log): return "Le moteur s’est arrêté au démarrage.\n\(log)"
      case .timeout(let log): return "Le moteur ne répond pas après 40 secondes.\n\(log)"
      case .configuration(let message): return message
      }
    }
  }

  static let shared = EngineController()

  let home: URL
  var tools: URL { home.appendingPathComponent("tools") }
  var resources: URL { Bundle.main.resourceURL ?? Bundle.main.bundleURL }
  var nodeURL: URL { resources.appendingPathComponent("node/bin/node") }
  var engineURL: URL { resources.appendingPathComponent("engine") }
  var helpersURL: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers") }

  private let lock = NSLock()
  private var process: Process?
  private var input: Pipe?
  private var stopping = false
  private var lines: [String] = []
  private var partial = ""
  private(set) var endpoint: Endpoint?
  /// Called on any thread when the engine exits without being asked to.
  var onUnexpectedExit: (@Sendable (String) -> Void)?

  init() {
    if let custom = ProcessInfo.processInfo.environment["AVITY_HOME"], !custom.isEmpty {
      home = URL(fileURLWithPath: custom, isDirectory: true)
    } else {
      home = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AvityOne", isDirectory: true)
    }
  }

  var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return process?.isRunning == true }
  var log: String { lock.lock(); defer { lock.unlock() }; return (lines + (partial.isEmpty ? [] : [partial])).joined(separator: "\n") }
  private func tail(_ count: Int = 15) -> String { lock.lock(); defer { lock.unlock() }; return lines.suffix(count).joined(separator: "\n") }

  /// Environment of the engine, and of the app's own terminals, so they find the same tools and the `avity` CLI.
  func environment(port: Int) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    for key in ["AVITY_TOKEN", "AVITY_DB", "NODE_OPTIONS"] { env.removeValue(forKey: key) }
    env["AVITY_HOME"] = home.path
    env["AVITY_HOST"] = "127.0.0.1"
    env["AVITY_PORT"] = String(port)
    env["AVITY_URL"] = "http://127.0.0.1:\(port)"
    env["NODE_NO_WARNINGS"] = "1"
    // npm installs from Administration go to a folder we own: no sudo, nothing written inside the signed app.
    env["NPM_CONFIG_PREFIX"] = tools.path
    env["NPM_CONFIG_UPDATE_NOTIFIER"] = "false"
    env["NPM_CONFIG_FUND"] = "false"
    if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
    env["PATH"] = ShellEnvironment.enginePath(tools: tools, node: nodeURL.deletingLastPathComponent(), helpers: helpersURL)
    return env
  }

  func start(preferredPort: Int) async throws -> Endpoint {
    let endpoint = try await Task.detached(priority: .userInitiated) { try self.launch(preferredPort: preferredPort) }.value
    try await waitReady(endpoint)
    return endpoint
  }

  private func launch(preferredPort: Int) throws -> Endpoint {
    guard FileManager.default.isExecutableFile(atPath: nodeURL.path) else { throw Failure.missingBundle(nodeURL.path) }
    let server = engineURL.appendingPathComponent("src/server.ts")
    guard FileManager.default.fileExists(atPath: server.path) else { throw Failure.missingBundle(server.path) }
    let token = try prepareHome()
    let port = bindableLoopbackPort(preferredPort) ?? bindableLoopbackPort(0) ?? preferredPort
    try writeCLI(port: port)

    let process = Process()
    process.executableURL = nodeURL
    process.arguments = [server.path]
    process.currentDirectoryURL = home
    var env = environment(port: port)
    env["AVITY_EMBEDDED"] = "1"
    process.environment = env
    let input = Pipe(), output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil; return }
      self?.append(String(decoding: data, as: UTF8.self))
    }
    process.terminationHandler = { [weak self] finished in self?.terminated(finished) }
    lock.lock()
    stopping = false
    lines.removeAll()
    partial = ""
    lock.unlock()
    try process.run()
    let endpoint = Endpoint(url: URL(string: "http://127.0.0.1:\(port)")!, token: token, port: port)
    lock.lock()
    self.process = process
    self.input = input
    self.endpoint = endpoint
    lock.unlock()
    return endpoint
  }

  private func waitReady(_ endpoint: Endpoint) async throws {
    let client = APIClient(baseURL: endpoint.url, token: endpoint.token)
    let deadline = Date().addingTimeInterval(40)
    while Date() < deadline {
      if !isRunning { throw Failure.exited(tail()) }
      if (try? await client.state()) != nil { return }
      try await Task.sleep(nanoseconds: 200_000_000)
    }
    throw Failure.timeout(tail())
  }

  /// Seeds config.json on first launch: loopback only, new projects in ~/AvityOne (outside the folders macOS protects),
  /// and a token (the engine only creates
  /// one when the file is missing, so a seeded file must carry it).
  private func prepareHome() throws -> String {
    let fm = FileManager.default
    try fm.createDirectory(at: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try fm.createDirectory(at: tools.appendingPathComponent("bin"), withIntermediateDirectories: true)
    let file = home.appendingPathComponent("config.json")
    var config: [String: JSONValue] = [:]
    if fm.fileExists(atPath: file.path) {
      guard let parsed = try? JSONValue.parse(String(contentsOf: file, encoding: .utf8)).object else {
        throw Failure.configuration("config.json illisible dans \(home.path) : corrige-le ou retire-le pour repartir des valeurs par défaut.")
      }
      config = parsed
    } else {
      config["host"] = "127.0.0.1"
      config["projectsDir"] = .string(fm.homeDirectoryForCurrentUser.appendingPathComponent("AvityOne").path)
    }
    if let token = config["token"]?.string, !token.isEmpty, fm.fileExists(atPath: file.path) { return token }
    let token = Self.randomToken()
    config["token"] = .string(token)
    let pending = home.appendingPathComponent("config.json.pending")
    try Data((JSONValue.object(config).pretty() + "\n").utf8).write(to: pending)
    chmod(pending.path, 0o600)
    guard rename(pending.path, file.path) == 0 else { throw Failure.configuration("Écriture de config.json impossible dans \(home.path).") }
    return token
  }

  static func randomToken() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /// `avity` in the app's tools: the engine's CLI, pointed at this engine.
  private func writeCLI(port: Int) throws {
    func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    let script = """
    #!/bin/sh
    # Généré par AvityOne.app à chaque démarrage du moteur.
    AVITY_HOME=\(quote(home.path)) AVITY_URL=\(quote("http://127.0.0.1:\(port)")) NODE_NO_WARNINGS=1 exec \(quote(nodeURL.path)) \(quote(engineURL.appendingPathComponent("src/cli.ts").path)) "$@"

    """
    let file = tools.appendingPathComponent("bin/avity")
    try Data(script.utf8).write(to: file, options: .atomic)
    chmod(file.path, 0o755)
  }

  private func append(_ text: String) {
    lock.lock(); defer { lock.unlock() }
    var chunk = partial + text
    var complete = chunk.components(separatedBy: "\n")
    chunk = complete.removeLast()
    partial = chunk
    lines.append(contentsOf: complete)
    if lines.count > 500 { lines.removeFirst(lines.count - 500) }
  }

  private func terminated(_ finished: Process) {
    lock.lock()
    let expected = stopping || finished !== process
    if finished === process { process = nil; input = nil }
    lock.unlock()
    guard !expected else { return }
    onUnexpectedExit?("Le moteur s’est arrêté (code \(finished.terminationStatus)).\n\(tail())")
  }

  /// Graceful stop: closing stdin runs the engine's shutdown (agents, terminals); SIGTERM, then SIGKILL, if it lingers.
  func stop(wait seconds: TimeInterval = 3) {
    lock.lock()
    stopping = true
    let process = self.process, input = self.input
    lock.unlock()
    guard let process, process.isRunning else { return }
    try? input?.fileHandleForWriting.close()
    let deadline = Date().addingTimeInterval(seconds)
    while process.isRunning && Date() < deadline { usleep(50_000) }
    if process.isRunning { process.terminate(); usleep(500_000) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
  }

  func restart(preferredPort: Int) async throws -> Endpoint {
    await Task.detached { self.stop() }.value
    return try await start(preferredPort: preferredPort)
  }
}
