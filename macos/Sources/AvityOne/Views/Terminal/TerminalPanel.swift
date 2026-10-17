import SwiftUI
import SwiftTerm
import AvityKit

/// Integrated terminal (⌘J). On this Mac: a real PTY (SwiftTerm) in the thread's folder, with the engine's PATH and
/// the `avity` CLI. On a remote server: the engine's pipe terminal.
struct TerminalPanel: View {
  @Environment(AppModel.self) private var app
  @State private var tabs: [TerminalTab] = []
  @State private var selected: UUID?

  struct TerminalTab: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var directory: String
    var sessionId: String?
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 4) {
        ForEach(tabs) { tab in
          HStack(spacing: 4) {
            Image(systemName: "terminal").font(.caption2)
            Text(tab.title).lineLimit(1).font(.caption)
            Button { close(tab) } label: { Image(systemName: "xmark").font(.caption2) }.buttonStyle(.borderless)
          }
          .padding(.horizontal, 8).padding(.vertical, 4)
          .background(selected == tab.id ? Palette.raised : .clear, in: RoundedRectangle(cornerRadius: 6))
          .onTapGesture { selected = tab.id }
        }
        Button { add() } label: { Image(systemName: "plus") }.buttonStyle(.borderless).help("Nouveau terminal").disabled(directory == nil)
        Spacer()
        Button { app.showTerminal = false } label: { Image(systemName: "chevron.down") }.buttonStyle(.borderless).help("Masquer (⌘J)")
      }
      .padding(.horizontal, 8).padding(.vertical, 4)
      ZStack {
        ForEach(tabs) { tab in
          Group {
            if app.isLocal {
              LocalTerminal(directory: tab.directory, environment: environment)
            } else if let session = tab.sessionId {
              RemoteTerminal(sessionId: session)
            }
          }
          .opacity(selected == tab.id ? 1 : 0)
          .allowsHitTesting(selected == tab.id)
        }
        if tabs.isEmpty {
          Text(directory == nil ? "Ouvre un fil ou un projet pour lancer un terminal." : "Aucun terminal").foregroundStyle(.secondary)
        }
      }
    }
    .background(SwiftUI.Color(nsColor: .textBackgroundColor).opacity(0.6))
    .onAppear { if tabs.isEmpty { add() } }
  }

  private var directory: String? { app.selectedThread?.workspacePath ?? app.selectedProject?.path }

  private var environment: [String] { app.terminalEnvironment() }

  private func add() {
    guard let directory else { return }
    let name = URL(fileURLWithPath: directory).lastPathComponent
    let tab = TerminalTab(title: name, directory: directory, sessionId: app.selectedSessionId)
    if !app.isLocal && tab.sessionId == nil { app.toast("Ouvre un fil pour lancer un terminal sur le serveur.", error: true); return }
    tabs.append(tab)
    selected = tab.id
  }

  private func close(_ tab: TerminalTab) {
    tabs.removeAll { $0.id == tab.id }
    if selected == tab.id { selected = tabs.last?.id }
  }
}

/// A login shell in a PTY, in the given folder; with `command`, that command alone (agent logins need a real TTY).
struct LocalTerminal: NSViewRepresentable {
  var directory: String
  var environment: [String]
  var command: String? = nil
  var onExit: ((Int32?) -> Void)? = nil

  final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
    var onExit: ((Int32?) -> Void)?
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) {
      let message = "\r\n[processus terminé\(exitCode.map { " : code \($0)" } ?? "")]\r\n"
      let onExit = self.onExit
      DispatchQueue.main.async {
        source.feed(text: message)
        onExit?(exitCode)
      }
    }
  }

  func makeCoordinator() -> Coordinator {
    let coordinator = Coordinator()
    coordinator.onExit = onExit
    return coordinator
  }

  func makeNSView(context: Context) -> LocalProcessTerminalView {
    let view = LocalProcessTerminalView(frame: .zero)
    view.processDelegate = context.coordinator
    view.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    view.nativeBackgroundColor = .textBackgroundColor
    view.nativeForegroundColor = .textColor
    let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
    if let command {
      view.startProcess(executable: shell, args: ["-l", "-c", command], environment: environment, execName: nil, currentDirectory: directory)
    } else {
      let name = "-" + URL(fileURLWithPath: shell).lastPathComponent
      view.startProcess(executable: shell, args: [], environment: environment, execName: name, currentDirectory: directory)
    }
    return view
  }

  func updateNSView(_ view: LocalProcessTerminalView, context: Context) {}

  static func dismantleNSView(_ view: LocalProcessTerminalView, coordinator: Coordinator) {
    view.terminate()
  }
}

/// The engine's terminal (`/bin/sh -i` with pipes, no PTY): enough for commands, not for full-screen programs.
struct RemoteTerminal: View {
  @Environment(AppModel.self) private var app
  var sessionId: String
  @State private var terminalId: String?
  @State private var output = ""
  @State private var offset = 0
  @State private var command = ""
  @State private var closed = false

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          Text(output.isEmpty ? "Terminal du serveur (sans PTY)." : output)
            .font(.system(size: 12, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .id("out")
        }
        .defaultScrollAnchor(.bottom)
        .onChange(of: output) { _, _ in proxy.scrollTo("out", anchor: .bottom) }
      }
      HStack {
        Text("$").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
        TextField("commande", text: $command)
          .textFieldStyle(.plain)
          .font(.system(size: 12, design: .monospaced))
          .onSubmit(send)
          .disabled(terminalId == nil || closed)
      }
      .padding(8)
    }
    .task(id: sessionId) { await run() }
  }

  private func run() async {
    guard let client = app.client else { return }
    do {
      let id = try await client.openTerminal(sessionId)
      terminalId = id
      defer { Task { try? await client.closeTerminal(sessionId, id: id) } }
      while !Task.isCancelled {
        let read = try await client.readTerminal(sessionId, id: id, offset: offset)
        if !read.output.isEmpty { output = String((output + read.output).suffix(200_000)) }
        offset = read.offset
        if read.closed { closed = true; output += "\n[terminal fermé]"; return }
        try await Task.sleep(nanoseconds: 400_000_000)
      }
    } catch {
      if !Task.isCancelled { output += "\n\(error.localizedDescription)" }
    }
  }

  private func send() {
    guard let id = terminalId, let client = app.client else { return }
    let input = command + "\n"
    command = ""
    Task { try? await client.writeTerminal(sessionId, id: id, input: input) }
  }
}

extension AppModel {
  /// The engine's environment (PATH with the agents' CLIs, `avity` pointed at this engine) for the app's own PTYs.
  func terminalEnvironment() -> [String] {
    var env = endpoint.map { engine.environment(port: $0.port) } ?? ProcessInfo.processInfo.environment
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    if env["LANG"] == nil { env["LANG"] = "fr_FR.UTF-8" }
    for key in ["AVITY_EMBEDDED", "AVITY_HOST", "AVITY_PORT"] { env.removeValue(forKey: key) }
    return env.map { "\($0.key)=\($0.value)" }
  }
}

/// Runs an agent's login command in a real terminal: browser sign-in, device codes and interactive menus all work.
struct LoginTerminalSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  var title: String
  var command: [String]
  var onClose: () -> Void
  @State private var finished: Int32??

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(title).font(.headline)
        Spacer()
        if let finished { Tag(text: finished == 0 ? "terminé" : "code \(finished.map(String.init) ?? "?")", color: finished == 0 ? Palette.green : Palette.amber) }
        Button(finished == nil ? "Annuler" : "Fermer") { dismiss(); onClose() }.keyboardShortcut(.cancelAction)
      }
      Text(command.joined(separator: " ")).font(.caption.monospaced()).foregroundStyle(.secondary)
      LocalTerminal(directory: FileManager.default.homeDirectoryForCurrentUser.path, environment: app.terminalEnvironment(),
                    command: command.map(Self.quote).joined(separator: " ")) { code in finished = .some(code) }
        .clipShape(RoundedRectangle(cornerRadius: 8))
      Text("Suis les instructions : une page de connexion peut s’ouvrir dans ton navigateur.").font(.caption).foregroundStyle(.secondary)
    }
    .padding(16)
    .frame(width: 760, height: 480)
  }

  static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}
