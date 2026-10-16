import SwiftUI
import AvityKit

struct SidebarView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.openWindow) private var openWindow
  @State private var filter = ""
  @State private var showArchived = false
  @State private var expanded: Set<Int> = []
  @State private var renaming: SessionRow?
  @State private var newTitle = ""
  @State private var deleting: SessionRow?

  var body: some View {
    VStack(spacing: 0) {
      List(selection: Binding(get: { app.selectedSessionId }, set: { id in if let id { app.select(session: id) } })) {
        ForEach(app.projects) { project in
          Section {
            if expanded.contains(project.id) || project.id == app.selectedProjectId {
              let rows = visibleSessions(project.id)
              if rows.isEmpty {
                Text(filter.isEmpty ? "Aucun fil" : "Aucun résultat").font(.callout).foregroundStyle(.tertiary).padding(.leading, 4)
              }
              ForEach(rows) { row in
                SessionRowView(row: row, child: row.parentId != nil)
                  .tag(row.id)
                  .contextMenu { menu(row) }
              }
            }
          } header: {
            ProjectHeader(project: project, expanded: expanded.contains(project.id) || project.id == app.selectedProjectId) {
              if project.id == app.selectedProjectId { expanded.remove(project.id); app.select(project: nil) }
              else if expanded.contains(project.id) { expanded.remove(project.id) }
              else {
                expanded.insert(project.id)
                if app.sessions[project.id] == nil { Task { await app.loadSessions(project.id) } }
              }
            } onNewThread: {
              app.select(project: project.id)
              app.startNewThread()
            }
          }
        }
      }
      .listStyle(.sidebar)
      .searchable(text: $filter, placement: .sidebar, prompt: "Filtrer les fils")
      Divider()
      SidebarFooter(showArchived: $showArchived)
    }
    .safeAreaInset(edge: .top) {
      HStack(spacing: 8) {
        LogoMark(size: 18)
        Text("AvityOne").font(.headline)
        Spacer()
        ProfileMenu()
        Button { app.startNewThread() } label: { Image(systemName: "square.and.pencil") }
          .buttonStyle(.borderless)
          .help("Nouveau fil (⌘N)")
          .disabled(app.selectedProjectId == nil)
      }
      .padding(.horizontal, 14).padding(.vertical, 8)
    }
    .alert("Renommer le fil", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Titre (vide : automatique)", text: $newTitle)
      Button("Renommer") { if let row = renaming { app.thread(row.id).rename(newTitle) } }
      Button("Annuler", role: .cancel) {}
    }
    .confirmationDialog("Supprimer ce fil et son historique ?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
      Button("Supprimer", role: .destructive) { if let row = deleting { app.thread(row.id).delete() } }
    } message: { Text("Les fichiers du projet ne sont pas touchés. Un worktree non fusionné bloque la suppression.") }
  }

  private func visibleSessions(_ project: Int) -> [SessionRow] {
    let rows = (app.sessions[project] ?? []).filter { showArchived || !$0.archived }
    let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
    let matched = query.isEmpty ? rows : rows.filter { $0.displayTitle.lowercased().contains(query) || ($0.summary ?? "").lowercased().contains(query) }
    // Parallel sub-sessions right under their parent.
    var ordered: [SessionRow] = []
    let children = Dictionary(grouping: matched.filter { $0.parentId != nil }, by: { $0.parentId! })
    for row in matched where row.parentId == nil {
      ordered.append(row)
      ordered.append(contentsOf: children[row.id] ?? [])
    }
    let shown = Set(ordered.map(\.id))
    return ordered + matched.filter { !shown.contains($0.id) }
  }

  @ViewBuilder private func menu(_ row: SessionRow) -> some View {
    Button("Ouvrir dans une nouvelle fenêtre") { openWindow(id: "thread", value: row.id) }
    Button("Renommer…") { newTitle = row.title ?? ""; renaming = row }
    Button(row.pinned ? "Désépingler" : "Épingler") { app.thread(row.id).setPinned(!row.pinned) }
    Button("Dupliquer") { app.thread(row.id).fork(before: nil) }
    Button("Exporter en Markdown…") { app.thread(row.id).exportMarkdown() }
    Divider()
    Button(row.archived ? "Restaurer" : "Archiver") { app.thread(row.id).setArchived(!row.archived) }
    Button("Supprimer…", role: .destructive) { deleting = row }
  }
}

struct ProjectHeader: View {
  @Environment(AppModel.self) private var app
  var project: Project
  var expanded: Bool
  var toggle: () -> Void
  var onNewThread: () -> Void
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.tertiary).frame(width: 10)
      Image(systemName: project.id == app.selectedProjectId ? "folder.fill" : "folder").foregroundStyle(project.id == app.selectedProjectId ? Palette.accentInk : .secondary)
      Text(project.name).font(.callout.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
      Spacer()
      let signal = app.activity.values.filter { $0.projectId == project.id }.compactMap { $0.signal }.max()
      SignalDot(signal: signal)
      if hovering {
        Button(action: onNewThread) { Image(systemName: "plus") }.buttonStyle(.borderless).help("Nouveau fil dans \(project.name)")
      }
    }
    .contentShape(Rectangle())
    .onTapGesture { toggle(); if !expanded { app.select(project: project.id) } }
    .onHover { hovering = $0 }
    .help(project.path)
    .contextMenu {
      Button("Nouveau fil") { onNewThread() }
      if app.isLocal {
        Button("Afficher dans le Finder") { OpenIn.reveal(project.path) }
      }
      Button("Copier le chemin") { copyToPasteboard(project.path) }
      Divider()
      Button("Réglages du projet…") { app.select(project: project.id); app.inspectorTab = .knowledge; app.showInspector = true }
    }
  }
}

struct SessionRowView: View {
  @Environment(AppModel.self) private var app
  var row: SessionRow
  var child: Bool

  var body: some View {
    HStack(spacing: 8) {
      if child { Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.tertiary) }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          if row.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.secondary) }
          Text(row.displayTitle).lineLimit(1).font(child ? .callout : .body)
            .foregroundStyle(row.archived ? .secondary : .primary)
        }
        HStack(spacing: 4) {
          if let agent = row.agent {
            Image(systemName: AgentIdentity.of(agent).symbol).foregroundStyle(AgentIdentity.of(agent).tint)
            Text(app.agents.first { $0.id == agent }?.name ?? agent)
          }
          if row.worktree != nil || row.isolated { Image(systemName: "arrow.triangle.branch") }
          Text(relativeTime(row.updatedAt))
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 4)
      SignalDot(signal: app.activity[row.id]?.signal)
    }
    .padding(.vertical, 2)
  }
}

struct SidebarFooter: View {
  @Environment(AppModel.self) private var app
  @Binding var showArchived: Bool

  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(app.link == .open ? Palette.green : Palette.amber).frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 0) {
        Text(app.preferences.activeProfile.name).font(.caption.weight(.medium))
        Text(app.isLocal ? "Moteur local\(app.endpoint.map { " · port \($0.port)" } ?? "")" : (app.link == .open ? "Connecté" : "Reconnexion…"))
          .font(.caption2).foregroundStyle(.secondary)
      }
      Spacer()
      HStack(spacing: -4) {
        ForEach(app.installedAgents) { agent in AgentAvatar(agent: agent.id, size: 18).help(agent.name) }
      }
      Menu {
        Toggle("Afficher les fils archivés", isOn: $showArchived)
        Button("Nouveau projet…") { app.showNewProject = true }
        Divider()
        SettingsLink { Text("Réglages…") }
      } label: { Image(systemName: "gearshape") }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
  }
}

/// Switches between this Mac's engine and remote servers.
struct ProfileMenu: View {
  @Environment(AppModel.self) private var app
  var body: some View {
    Menu {
      ForEach(app.preferences.profiles) { profile in
        Button {
          Task { await app.switchProfile(profile.id) }
        } label: {
          Label(profile.name, systemImage: profile.id == app.preferences.activeProfileId ? "checkmark" : (profile.isLocal ? "laptopcomputer" : "server.rack"))
        }
      }
      Divider()
      SettingsLink { Text("Gérer les serveurs…") }
    } label: {
      Image(systemName: app.isLocal ? "laptopcomputer" : "server.rack")
    }
    .menuStyle(.borderlessButton)
    .fixedSize()
    .help("Où travaillent les agents")
  }
}
