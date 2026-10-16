import SwiftUI
import AvityKit

struct ThreadView: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel

  var body: some View {
    VStack(spacing: 0) {
      if !thread.loaded {
        if let error = thread.error {
          ContentUnavailableView { Label("Fil indisponible", systemImage: "exclamationmark.triangle") } description: { Text(error) } actions: {
            Button("Réessayer") { Task { await thread.load() } }
          }
        } else {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      } else {
        FeedView(thread: thread)
        if thread.planReady { PlanReadyBar(thread: thread) }
        ComposerView(composer: thread.composer, thread: thread)
      }
    }
    .navigationTitle(thread.title)
    .navigationSubtitle(thread.project?.name ?? "")
    .onChange(of: thread.composer.text) { _, _ in thread.draftChanged() }
    .task(id: thread.id) { app.markSeen(thread.id) }
  }
}

/// A thread in its own window (« Ouvrir dans une nouvelle fenêtre »), optionally always on top.
struct DetachedThreadView: View {
  @Environment(AppModel.self) private var app
  var sessionId: String
  @State private var floating = false

  var body: some View {
    Group {
      if app.connection == .ready, let thread = app.threads[sessionId] {
        ThreadView(thread: thread)
      } else {
        StartingView(message: "Connexion…")
      }
    }
    .task(id: app.connection == .ready) {
      guard app.connection == .ready else { return }
      let thread = app.thread(sessionId)
      if !thread.loaded { await thread.load() }
    }
    .toolbar {
      ToolbarItem {
        Toggle(isOn: $floating) { Label("Toujours au premier plan", systemImage: floating ? "pin.fill" : "pin") }
          .help("Garder cette fenêtre au-dessus des autres")
      }
    }
    .background(WindowLevel(floating: floating))
  }
}

/// Sets the hosting window's level.
struct WindowLevel: NSViewRepresentable {
  var floating: Bool
  func makeNSView(context: Context) -> NSView { NSView() }
  func updateNSView(_ view: NSView, context: Context) {
    DispatchQueue.main.async { view.window?.level = floating ? .floating : .normal }
  }
}

struct FeedView: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel

  var body: some View {
    let items = thread.feed.items
    let (turns, retry) = thread.feed.turns()
    let lastUser = thread.feed.lastUserIndex ?? -1
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if items.isEmpty { EmptyThreadHint(thread: thread) }
          ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            if showsHead(at: index, in: items) {
              AgentHead(agent: thread.feed.agent(at: index), working: thread.live.busy && index > lastUser, name: agentName(thread.feed.agent(at: index)))
            }
            FeedRow(item: item, thread: thread, latest: index > lastUser, turn: item.itemType == .end ? turns[item.id] : nil, retry: item.id == retry)
              .id(item.id)
          }
          if thread.live.busy {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text(thread.feed.activityLabel()).foregroundStyle(.secondary)
              if thread.live.waiting { Tag(text: "attend ta validation", color: Palette.amber) }
            }
            .font(.callout)
            .padding(.leading, 34)
            .id("activity")
          }
          Color.clear.frame(height: 8).id("bottom")
        }
        .padding(.horizontal, 28)
        .padding(.top, 18)
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.bottom)
      .onChange(of: items.count) { old, new in
        if new > old, items.last?.itemType == .user { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
      }
      .onChange(of: thread.focusItem) { _, id in
        if let id { withAnimation { proxy.scrollTo(id, anchor: .center) }; thread.focusItem = nil }
      }
    }
  }

  private func agentName(_ id: String?) -> String {
    app.agents.first { $0.id == id }?.name ?? id ?? "Agent"
  }

  /// The turn's agent header goes above the first item the agent produces.
  private func showsHead(at index: Int, in items: [Item]) -> Bool {
    let agentTypes: Set<ItemType> = [.thought, .tool, .plan, .assistant, .permission]
    guard agentTypes.contains(items[index].itemType) else { return false }
    for previous in items[..<index].reversed() {
      if previous.itemType == .user { return true }
      if agentTypes.contains(previous.itemType) { return false }
    }
    return true
  }
}

struct AgentHead: View {
  var agent: String?
  var working: Bool
  var name: String
  var body: some View {
    HStack(spacing: 8) {
      AgentAvatar(agent: agent, size: 26, working: working)
      Text(name).font(.callout.weight(.semibold))
    }
    .padding(.top, 4)
  }
}

struct EmptyThreadHint: View {
  @Bindable var thread: ThreadModel
  var body: some View {
    VStack(spacing: 8) {
      Text("Fil vide").font(.headline)
      Text("Écris une demande ci-dessous. `@codex`, `@claude`… choisissent l’agent, `/plan` démarre en mode plan.").foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 80)
  }
}

/// « Plan prêt » : run the plan with an agent, or split it into parallel isolated tasks.
struct PlanReadyBar: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  @State private var agent = "auto"

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "checklist").foregroundStyle(Palette.accentInk)
      VStack(alignment: .leading, spacing: 1) {
        Text("Plan prêt").font(.callout.weight(.semibold))
        Text("Relis-le, ajuste-le dans l’onglet Plan, puis exécute.").font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Picker("Agent", selection: $agent) {
        Text("Auto").tag("auto")
        ForEach(app.installedAgents) { Text($0.name).tag($0.id) }
      }
      .labelsHidden()
      .fixedSize()
      Button("Modifier le plan") { app.inspectorTab = .plan; app.showInspector = true }
      Button("Paralléliser") { thread.parallel() }.help("Une sous-session isolée par tâche, dans son worktree")
      Button("Exécuter le plan") { thread.execute(agent: agent) }.buttonStyle(.borderedProminent)
    }
    .padding(.horizontal, 16).padding(.vertical, 10)
    .background(Palette.accent.opacity(0.10))
    .overlay(alignment: .top) { Divider() }
  }
}

/// A new thread in the selected project: created on the first message.
struct NewThreadView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 18) {
          LogoMark(size: 44)
          Text(app.selectedProject.map { "Que construit-on dans \($0.name) ?" } ?? "Que construit-on ?").font(.title.weight(.semibold))
          Text(app.selectedProject?.path ?? "").font(.callout.monospaced()).foregroundStyle(.secondary)
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 10)], spacing: 10) {
            ForEach(Self.suggestions) { suggestion in
              Button { app.newThread.text = suggestion.prompt; app.focusComposer += 1 } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(suggestion.title).font(.callout.weight(.semibold))
                  Text(suggestion.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line))
              }
              .buttonStyle(.plain)
            }
          }
          .frame(maxWidth: 760)
          if app.installedAgents.isEmpty {
            Card(tint: Palette.amber) {
              HStack {
                Text("Aucun agent installé : installe Claude Code, Codex, Cursor ou OpenCode.")
                Spacer()
                SettingsLink { Text("Agents…") }
              }
            }
            .frame(maxWidth: 760)
          }
        }
        .padding(.top, 70)
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity)
      }
      ComposerView(composer: app.newThread, thread: nil)
    }
    .navigationTitle("Nouveau fil")
    .navigationSubtitle(app.selectedProject?.name ?? "")
  }

  struct Suggestion: Identifiable { var title: String; var prompt: String; var id: String { title } }
  static let suggestions: [Suggestion] = [
    Suggestion(title: "Comprendre le projet", prompt: "Explique l’architecture de ce projet : modules, flux de données et points d’entrée."),
    Suggestion(title: "Planifier une fonction", prompt: "/plan Ajoute une fonction : décris-la ici, avec ses critères d’acceptation."),
    Suggestion(title: "Corriger un bug", prompt: "Trouve et corrige ce bug : décris le symptôme et comment le reproduire."),
    Suggestion(title: "Écrire des tests", prompt: "Ajoute des tests pour les parties critiques non couvertes, puis lance-les."),
    Suggestion(title: "Revue du code", prompt: "/review Relis les changements non commités et signale les risques."),
    Suggestion(title: "Documenter", prompt: "Mets à jour le README et la documentation d’après le code actuel."),
  ]
}
