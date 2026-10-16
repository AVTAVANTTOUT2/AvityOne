import SwiftUI
import AvityKit

/// Codex-like layout: projects and threads on the left, the thread in the middle, review tools on the right (⌥⌘B),
/// the terminal at the bottom (⌘J).
struct MainView: View {
  @Environment(AppModel.self) private var app
  @State private var visibility = NavigationSplitViewVisibility.all

  var body: some View {
    @Bindable var app = app
    NavigationSplitView(columnVisibility: $visibility) {
      SidebarView()
        .navigationSplitViewColumnWidth(min: 230, ideal: 272, max: 380)
    } detail: {
      DetailView()
    }
    .inspector(isPresented: $app.showInspector) {
      InspectorView()
        .inspectorColumnWidth(min: 380, ideal: 500, max: 960)
    }
    .toolbar { MainToolbar() }
    .sheet(isPresented: $app.showNewProject) { NewProjectSheet() }
    .sheet(isPresented: $app.showPalette) { CommandPalette() }
  }
}

struct DetailView: View {
  @Environment(AppModel.self) private var app
  @State private var terminalHeight: CGFloat = 260

  var body: some View {
    VStack(spacing: 0) {
      if app.link == .lost {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(app.isLocal ? "Connexion au moteur perdue : reconnexion…" : "Serveur injoignable : reconnexion…")
          Spacer()
          Button("Réessayer") { Task { await app.connect() } }.buttonStyle(.link)
        }
        .font(.callout)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Palette.amber.opacity(0.14))
      }
      Group {
        if let thread = app.selectedThread {
          ThreadView(thread: thread)
        } else if app.selectedProject != nil {
          NewThreadView()
        } else {
          EmptyProjectsView()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      if app.showTerminal {
        ResizeHandle(height: $terminalHeight)
        TerminalPanel()
          .frame(height: terminalHeight)
      }
    }
  }
}

struct ResizeHandle: View {
  @Binding var height: CGFloat
  @State private var start: CGFloat?
  var body: some View {
    Rectangle()
      .fill(Palette.line)
      .frame(height: 1)
      .overlay(Color.clear.frame(height: 8).contentShape(Rectangle()))
      .onHover { inside in if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() } }
      .gesture(DragGesture(minimumDistance: 1).onChanged { value in
        let base = start ?? height
        if start == nil { start = height }
        height = min(max(base - value.translation.height, 120), 700)
      }.onEnded { _ in start = nil })
  }
}

struct EmptyProjectsView: View {
  @Environment(AppModel.self) private var app
  var body: some View {
    VStack(spacing: 14) {
      LogoMark(size: 48)
      Text("Aucun projet").font(.title2.weight(.semibold))
      Text("Ajoute un dossier de code, clone un dépôt ou crée un dossier vide.").foregroundStyle(.secondary)
      Button("Nouveau projet…") { app.showNewProject = true }.buttonStyle(.borderedProminent)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct MainToolbar: ToolbarContent {
  @Environment(AppModel.self) private var app
  @Environment(\.openWindow) private var openWindow

  var body: some ToolbarContent {
    ToolbarItemGroup(placement: .navigation) {
      if let thread = app.selectedThread {
        ThreadBadges(thread: thread)
      }
    }
    ToolbarItemGroup(placement: .primaryAction) {
      if let thread = app.selectedThread {
        if app.isLocal, let path = thread.workspacePath { OpenInMenu(path: path) }
        GitMenu(thread: thread)
        Menu {
          Button("Ouvrir dans une nouvelle fenêtre") { openWindow(id: "thread", value: thread.id) }
          Button("Revue croisée") { thread.review() }
          Button("Résumer et mémoriser") { thread.summarize() }
          Divider()
          Button(thread.session?.pinned == true ? "Désépingler" : "Épingler") { thread.setPinned(!(thread.session?.pinned ?? false)) }
          Button("Dupliquer") { thread.fork(before: nil) }
          Button("Exporter en Markdown…") { thread.exportMarkdown() }
          Button(thread.session?.archived == true ? "Restaurer" : "Archiver") { thread.setArchived(!(thread.session?.archived ?? false)) }
        } label: { Label("Plus", systemImage: "ellipsis.circle") }
      }
      Button { app.showTerminal.toggle() } label: { Label("Terminal", systemImage: "terminal") }
        .help("Terminal (⌘J)")
      Button { app.showInspector.toggle() } label: { Label("Revue", systemImage: "sidebar.right") }
        .help("Revue, fusion, plan, fichiers et mémoire (⌥⌘B)")
    }
  }
}

/// Agent, model, workspace and branch of the open thread.
struct ThreadBadges: View {
  @Bindable var thread: ThreadModel
  var body: some View {
    HStack(spacing: 6) {
      if let agent = thread.live.agent ?? thread.session?.agent {
        AgentAvatar(agent: agent, size: 18, working: thread.live.busy)
        Text(thread.app.agents.first { $0.id == agent }?.name ?? agent).font(.callout.weight(.medium))
      }
      if let model = thread.live.selectors.first(where: { $0.category == "model" }) { Tag(text: model.currentName) }
      if thread.live.isolated || thread.session?.worktree != nil { Tag(text: "Worktree", color: Palette.violet, symbol: "arrow.triangle.branch") }
      if let branch = thread.git?.branch { Tag(text: branch, color: Palette.accentInk, symbol: "point.topleft.down.to.point.bottomright.curvepath") }
      if thread.live.queued > 0 { Tag(text: "\(thread.live.queued) en file", color: Palette.amber) }
    }
  }
}

struct OpenInMenu: View {
  @Environment(AppModel.self) private var app
  var path: String
  var body: some View {
    let targets = OpenIn.installed()
    let preferred = targets.first { $0.id == app.preferences.openIn } ?? targets.first
    Menu {
      ForEach(targets) { target in
        Button { app.preferences.openIn = target.id; OpenIn.open(path, in: target) } label: { Label(target.name, systemImage: target.symbol) }
      }
      Divider()
      Button("Copier le chemin") { copyToPasteboard(path) }
    } label: {
      Label(preferred.map { "Ouvrir dans \($0.name)" } ?? "Ouvrir", systemImage: preferred?.symbol ?? "arrow.up.forward.app")
    } primaryAction: {
      if let preferred { OpenIn.open(path, in: preferred) }
    }
    .help("Ouvrir le dossier du fil")
  }
}
