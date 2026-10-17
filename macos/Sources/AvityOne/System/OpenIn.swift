import AppKit

/// « Ouvrir dans » : the thread's folder (its worktree when isolated) in Finder, a terminal or an editor.
enum OpenIn {
  struct Target: Identifiable, Hashable {
    var id: String
    var name: String
    var symbol: String
  }

  static let all: [Target] = [
    Target(id: "com.apple.finder", name: "Finder", symbol: "folder"),
    Target(id: "com.microsoft.VSCode", name: "Visual Studio Code", symbol: "chevron.left.forwardslash.chevron.right"),
    Target(id: "com.todesktop.230313mzl4w4u92", name: "Cursor", symbol: "cube"),
    Target(id: "dev.zed.Zed", name: "Zed", symbol: "bolt"),
    Target(id: "com.exafunction.windsurf", name: "Windsurf", symbol: "wind"),
    Target(id: "com.apple.dt.Xcode", name: "Xcode", symbol: "hammer"),
    Target(id: "com.jetbrains.intellij", name: "IntelliJ IDEA", symbol: "curlybraces"),
    Target(id: "com.sublimetext.4", name: "Sublime Text", symbol: "text.cursor"),
    Target(id: "com.apple.Terminal", name: "Terminal", symbol: "terminal"),
    Target(id: "com.googlecode.iterm2", name: "iTerm", symbol: "terminal"),
    Target(id: "com.mitchellh.ghostty", name: "Ghostty", symbol: "terminal"),
    Target(id: "dev.warp.Warp-Stable", name: "Warp", symbol: "terminal"),
  ]

  static func installed() -> [Target] {
    all.filter { $0.id == "com.apple.finder" || NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0.id) != nil }
  }

  static func open(_ path: String, in target: Target) {
    let url = URL(fileURLWithPath: path, isDirectory: true)
    if target.id == "com.apple.finder" { NSWorkspace.shared.activateFileViewerSelecting([url]); return }
    guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target.id) else { return }
    NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
  }

  static func reveal(_ path: String) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
}
