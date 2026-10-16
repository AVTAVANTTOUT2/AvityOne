import SwiftUI
import AvityKit

struct SettingsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    TabView {
      GeneralSettings().tabItem { Label("Général", systemImage: "gearshape") }
      AgentsSettings().tabItem { Label("Agents", systemImage: "person.2.badge.gearshape") }
      PermissionsSettings().tabItem { Label("Autorisations", systemImage: "lock.shield") }
      ConnectionsSettings().tabItem { Label("Connexions", systemImage: "network") }
      RoutingSettings().tabItem { Label("Routage", systemImage: "arrow.triangle.branch") }
      McpSettings().tabItem { Label("MCP", systemImage: "puzzlepiece.extension") }
      AdvancedSettings().tabItem { Label("Avancé", systemImage: "wrench.and.screwdriver") }
    }
    .frame(width: 760, height: 600)
  }
}

struct GeneralSettings: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var preferences = app.preferences
    Form {
      Section("Apparence") {
        Picker("Thème", selection: $preferences.appearance) { ForEach(Preferences.Appearance.allCases) { Text($0.label).tag($0) } }
      }
      Section("Nouveaux fils") {
        Toggle("Travailler dans un worktree isolé par défaut", isOn: $preferences.newThreadsIsolated)
        Picker("Ouvrir les dossiers dans", selection: $preferences.openIn) {
          ForEach(OpenIn.installed()) { Text($0.name).tag($0.id) }
        }
      }
      Section("Notifications") {
        Picker("Notifier", selection: $preferences.notifyWhen) { ForEach(Preferences.NotifyWhen.allCases) { Text($0.label).tag($0) } }
        Toggle("Sons", isOn: $preferences.sounds)
        Text("Fin de tour, échec et autorisation en attente. Une demande d’autorisation se valide depuis la notification.").font(.caption).foregroundStyle(.secondary)
      }
      Section("Dictée") {
        Picker("Langue", selection: $preferences.dictationLanguage) { ForEach(Preferences.languages) { Text($0.name).tag($0.id) } }
        Text("Maintiens ⌃M dans le compositeur. Sans moteur de transcription configuré sur le moteur, la reconnaissance se fait sur ce Mac : l’audio ne quitte pas l’appareil.")
          .font(.caption).foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
  }
}

/// Install, connect and check each agent. On this Mac the login runs in a real terminal.
struct AgentsSettings: View {
  @Environment(AppModel.self) private var app
  @State private var agents: [AgentEntry] = []
  @State private var operation: AgentOperation?
  @State private var login: AgentEntry?
  @State private var probing: Set<String> = []
  @State private var input = ""
  @State private var developerTools = Toolchain.developerToolsInstalled()
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if app.isLocal {
          ToolRow(title: "Outils de développement Apple (git)", ok: developerTools,
                  detail: developerTools ? "Command Line Tools installés." : "git est requis pour les worktrees, la revue et la fusion.",
                  action: developerTools ? nil : ("Installer…", { Toolchain.installDeveloperTools() }),
                  refresh: { developerTools = Toolchain.developerToolsInstalled() })
        }
        HStack {
          Text("Agents").font(.headline)
          Spacer()
          Button("Tout installer") { installAll() }.disabled(operation?.running == true || agents.allSatisfy { $0.installed && $0.catalog?.commandInstalled != false })
          Button("Actualiser") { Task { await load() } }
        }
        if let error { Text(error).foregroundStyle(Palette.red).font(.callout) }
        ForEach(agents) { agent in
          AgentCard(agent: agent, probing: probing.contains(agent.id), busy: operation?.running == true,
                    install: { start(agent.id, "install") },
                    connect: { if app.isLocal { login = agent } else { start(agent.id, "connect") } },
                    probe: { probe(agent.id) })
        }
        if let operation {
          GroupBox {
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text("\(operation.action == "install" ? "Installation" : "Connexion") · \(operation.agent)").font(.callout.weight(.semibold))
                Spacer()
                Tag(text: operation.state, color: operation.state == "success" ? Palette.green : operation.state == "error" ? Palette.red : Palette.accentInk)
              }
              ScrollView { Text(operation.output.isEmpty ? "…" : operation.output).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                .frame(height: 140)
              if operation.running && operation.action == "connect" {
                HStack {
                  TextField("Réponse au CLI (code, choix…)", text: $input).textFieldStyle(.roundedBorder)
                  Button("Envoyer") { sendInput() }
                }
              }
            }
          }
        }
        Text(app.isLocal ? "Les CLI s’installent dans \(app.engine.tools.path), sans sudo. Cursor et l’installateur natif de Claude utilisent ~/.local/bin." : "Installations et connexions s’exécutent sur le serveur distant.")
          .font(.caption).foregroundStyle(.secondary)
      }
      .padding(18)
    }
    .task { await load() }
    .sheet(item: $login) { agent in
      LoginTerminalSheet(title: "Connexion à \(agent.name)", command: agent.catalog?.loginCommand ?? []) { probe(agent.id) }
    }
  }

  private func load() async {
    guard let client = app.client else { return }
    do { agents = try await client.agents(); error = nil } catch { self.error = error.localizedDescription }
  }

  private func start(_ agent: String, _ action: String) {
    guard let client = app.client else { return }
    Task {
      do {
        var op = try await client.agentOperation(agent: agent, action: action)
        operation = op
        while op.running {
          try await Task.sleep(nanoseconds: 1_000_000_000)
          op = try await client.operation(op.id)
          operation = op
        }
        await load()
        try? await app.refreshState()
        if op.state == "success" && action == "install" { probe(agent) }
      } catch { app.toast(error.localizedDescription, error: true) }
    }
  }

  private func installAll() {
    Task {
      for agent in agents where !agent.installed || agent.catalog?.commandInstalled == false {
        start(agent.id, "install")
        try? await Task.sleep(nanoseconds: 500_000_000)
        while operation?.running == true { try? await Task.sleep(nanoseconds: 500_000_000) }
      }
    }
  }

  private func probe(_ agent: String) {
    guard let client = app.client else { return }
    probing.insert(agent)
    Task {
      _ = try? await client.probe(agent: agent)
      probing.remove(agent)
      await load()
    }
  }

  private func sendInput() {
    guard let id = operation?.id, let client = app.client else { return }
    let text = input
    input = ""
    Task { operation = try? await client.operationInput(id, input: text) }
  }
}

struct ToolRow: View {
  var title: String
  var ok: Bool
  var detail: String
  var action: (String, () -> Void)?
  var refresh: () -> Void
  var body: some View {
    HStack {
      Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill").foregroundStyle(ok ? Palette.green : Palette.amber)
      VStack(alignment: .leading) {
        Text(title).font(.callout.weight(.medium))
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      if let action { Button(action.0, action: action.1) }
      Button { refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless)
    }
    .padding(10)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
  }
}

struct AgentCard: View {
  var agent: AgentEntry
  var probing: Bool
  var busy: Bool
  var install: () -> Void
  var connect: () -> Void
  var probe: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AgentAvatar(agent: agent.id, size: 34, working: probing)
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(agent.name).font(.headline)
          Tag(text: agent.installed ? "installé" : "absent", color: agent.installed ? Palette.green : .secondary)
          if let health = agent.health {
            Tag(text: Self.status(health.status), color: health.status == "ready" ? Palette.green : health.status == "unavailable" ? Palette.red : .secondary)
            if health.authentication == "required" { Tag(text: "connexion requise", color: Palette.amber) }
            if let quota = health.quotaSnapshot, quota.status != "unknown" {
              Tag(text: quota.status == "exhausted" ? "quota épuisé" : "quota \(Self.quota(quota))", color: quota.status == "exhausted" ? Palette.red : Palette.accentInk)
            }
          }
        }
        Text(agent.strengths).font(.caption).foregroundStyle(.secondary)
        if let error = agent.health?.error { Text(error).font(.caption).foregroundStyle(Palette.red).lineLimit(3).textSelection(.enabled) }
        if let checked = agent.health?.checkedAt, let date = parseServerDate(checked) {
          Text("Vérifié \(date.formatted(.relative(presentation: .named)))").font(.caption2).foregroundStyle(.tertiary)
        }
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 6) {
        if agent.catalog != nil && (!agent.installed || agent.catalog?.commandInstalled == false) {
          Button("Installer", action: install).disabled(busy)
        }
        if agent.catalog != nil {
          Button("Connecter", action: connect).disabled(busy || agent.catalog?.commandInstalled == false)
        }
        Button(probing ? "Vérification…" : "Vérifier", action: probe).disabled(probing || !agent.installed)
        if let docs = agent.catalog?.docs, let url = URL(string: docs) { Link("Documentation", destination: url).font(.caption) }
      }
    }
    .padding(12)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line))
  }

  static func status(_ status: String) -> String {
    ["ready": "prêt", "unavailable": "indisponible", "missing": "introuvable", "unknown": "non vérifié"][status] ?? status
  }

  static func quota(_ q: QuotaSnapshot) -> String {
    guard let remaining = q.remaining, let limit = q.limit, limit > 0 else { return "disponible" }
    let percent = remaining / limit * 100
    return percent > 0 && percent < 0.1 ? "< 0,1 %" : "\(Int(percent.rounded())) %"
  }
}

struct PermissionsSettings: View {
  @Environment(AppModel.self) private var app
  @State private var permissions = SystemPermissions.shared
  @State private var autoApprove: Bool?

  var body: some View {
    Form {
      Section("Autorisations macOS") {
        PermissionRow(title: "Notifications", detail: "Fin de tour, échec, validation en attente.", status: permissions.notifications,
                      grant: { Task { await permissions.requestNotifications() } }, settings: { SystemPermissions.openNotificationSettings() })
        PermissionRow(title: "Micro", detail: "Dictée dans le compositeur.", status: permissions.microphone,
                      grant: { Task { await permissions.requestMicrophone() } }, settings: { SystemPermissions.openPrivacy("Privacy_Microphone") })
        PermissionRow(title: "Reconnaissance vocale", detail: "Transcription sur l’appareil.", status: permissions.speech,
                      grant: { Task { await permissions.requestSpeech() } }, settings: { SystemPermissions.openPrivacy("Privacy_SpeechRecognition") })
        PermissionRow(title: "Enregistrement de l’écran", detail: "Joindre une capture d’écran à une demande.", status: permissions.screen,
                      grant: { permissions.requestScreen() }, settings: { SystemPermissions.openPrivacy("Privacy_ScreenCapture") })
        PermissionRow(title: "Accès complet au disque", detail: "Facultatif : évite les demandes pour Documents, Bureau ou les disques externes. Les agents héritent de cet accès.", status: permissions.fullDisk,
                      grant: nil, settings: { SystemPermissions.openPrivacy("Privacy_AllFiles") })
      }
      Section("Actions des agents") {
        if let autoApprove {
          Toggle("Approbation automatique par défaut", isOn: Binding(get: { autoApprove }, set: { value in
            self.autoApprove = value
            app.run { _ = try await app.client?.updateConfig(["autoApprove": .bool(value)]) }
          }))
          Text("Les lectures sont toujours autorisées. En mode plan, les modifications, suppressions et commandes, ainsi que la sortie du mode plan, te sont toujours demandées. Chaque fil peut changer ce réglage depuis le compositeur.")
            .font(.caption).foregroundStyle(.secondary)
        } else { ProgressView() }
      }
    }
    .formStyle(.grouped)
    .task {
      await permissions.refresh()
      autoApprove = (try? await app.client?.config())?["autoApprove"]?.bool ?? true
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await permissions.refresh() } }
  }
}

struct PermissionRow: View {
  var title: String
  var detail: String
  var status: SystemPermissions.Status
  var grant: (() -> Void)?
  var settings: () -> Void
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Tag(text: status.label, color: status.color)
      if status != .granted {
        if let grant, status == .undetermined || status == .unknown { Button("Autoriser", action: grant) }
        Button("Réglages…", action: settings)
      }
    }
  }
}
