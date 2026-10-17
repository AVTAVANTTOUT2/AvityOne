import Foundation

/// Attaches a screenshot: macOS's own selection tool (`screencapture -i`; space toggles window mode). The first use
/// asks for the Screen Recording permission.
enum ScreenCapture {
  static func interactive() async -> URL? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capture-\(UUID().uuidString.prefix(8)).png")
    let status: Int32 = await Task.detached {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
      process.arguments = ["-i", "-x", url.path]
      do { try process.run() } catch { return -1 }
      process.waitUntilExit()
      return process.terminationStatus
    }.value
    return status == 0 && FileManager.default.fileExists(atPath: url.path) ? url : nil
  }
}
