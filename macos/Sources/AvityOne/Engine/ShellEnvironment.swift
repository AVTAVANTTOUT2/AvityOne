import Foundation

/// A GUI app inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`): no npm, no agent CLI, no Homebrew.
/// The engine gets a complete PATH instead: the app's tools first, the usual install folders, then the user's
/// login shell PATH, read once like VS Code does.
enum ShellEnvironment {
  private static let marker = "__AVITY_PATH__"
  private static let cache = LoginPathCache()

  final class LoginPathCache: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String]?
    func get(_ compute: () -> [String]) -> [String] {
      lock.lock(); defer { lock.unlock() }
      if let value { return value }
      let computed = compute()
      value = computed
      return computed
    }
  }

  /// The PATH of an interactive login shell, or nothing if it fails or takes more than 5 s.
  static func loginShellPath() -> [String] {
    cache.get {
      let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
      let process = Process()
      process.executableURL = URL(fileURLWithPath: shell)
      process.arguments = ["-ilc", "printf '\\n\(marker)%s\(marker)\\n' \"$PATH\""]
      let output = Pipe()
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      process.standardInput = FileHandle.nullDevice
      guard (try? process.run()) != nil else { return [] }
      final class Output: @unchecked Sendable { var data = Data() }
      let done = DispatchSemaphore(value: 0)
      let read = Output()
      let handle = output.fileHandleForReading
      DispatchQueue.global().async {
        read.data = handle.readDataToEndOfFile()
        done.signal()
      }
      if done.wait(timeout: .now() + 5) == .timedOut {
        process.terminate()
        _ = done.wait(timeout: .now() + 1)
      }
      let text = String(decoding: read.data, as: UTF8.self)
      guard let start = text.range(of: marker), let end = text.range(of: marker, range: start.upperBound..<text.endIndex) else { return [] }
      return text[start.upperBound..<end.lowerBound].split(separator: ":").map(String.init).filter { !$0.isEmpty }
    }
  }

  static func enginePath(tools: URL, node: URL, helpers: URL) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let first = [tools.appendingPathComponent("bin").path, node.path, "\(home)/.local/bin", "\(home)/.opencode/bin", "\(home)/.bun/bin",
                 "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
    let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    // Our pdftotext only when Poppler is absent; Tailscale's CLI ships inside its app.
    let last = [helpers.path, "/Applications/Tailscale.app/Contents/MacOS"]
    var seen = Set<String>()
    return (first + loginShellPath() + system + last).filter { seen.insert($0).inserted }.joined(separator: ":")
  }

  static func which(_ command: String, path: String) -> String? {
    for dir in path.split(separator: ":") {
      let candidate = "\(dir)/\(command)"
      if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
  }
}

/// Developer tools the engine relies on: git comes with Apple's Command Line Tools.
enum Toolchain {
  static func run(_ executable: String, _ arguments: [String]) -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    process.standardInput = FileHandle.nullDevice
    do { try process.run() } catch { return (-1, error.localizedDescription) }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
  }

  /// `xcode-select -p` fails until the Command Line Tools (or Xcode) are installed; /usr/bin/git is only a stub then.
  static func developerToolsInstalled() -> Bool { run("/usr/bin/xcode-select", ["-p"]).status == 0 }

  /// Opens Apple's installer dialog; it runs on its own.
  static func installDeveloperTools() { _ = run("/usr/bin/xcode-select", ["--install"]) }

  static var homebrew: String? {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].first { FileManager.default.isExecutableFile(atPath: $0) }
  }
}
