import SwiftUI
import AvityKit

/// ⌘K: actions, threads by title, projects and a full-text search of the project's conversations.
struct CommandPalette: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openSettings) private var openSettings
  @State private var query = ""
  @State private var hits: [SearchHit] = []
  @State private var selection = 0
  @FocusState private var focused: Bool

  struct Entry: Identifiable {
    var id: String
    var title: String
    var detail: String
    var symbol: String
    var run: () -> Void
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Rechercher un fil, un message ou une action…", text: $query)
          .textFieldStyle(.plain)
          .font(.title3)
          .focused($focused)
          .onSubmit { execute(selection) }
          .onKeyPress(.downArrow) { selection = min(selection + 1, max(entries.count - 1, 0)); return .handled }
          .onKeyPress(.upArrow) { selection = max(selection - 1, 0); return .handled }
          .onKeyPress(.escape) { dismiss(); return .handled }
      }
      .padding(14)
      Divider()
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 2) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
              Button { execute(index) } label: {
                HStack(spacing: 10) {
                  Image(systemName: entry.symbol).frame(width: 18).foregroundStyle(.secondary)
                  VStack(alignment: .leading, spacing: 1) {
                    Text(entry.title).lineLimit(1)
                    if !entry.detail.isEmpty { Text(entry.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                  }
                  Spacer()
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(index == selection ? Palette.accent.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .id(index)
            }
          }
          .padding(8)
        }
        .onChange(of: selection) { _, index in proxy.scrollTo(index) }
      }
    }
    .frame(width: 620, height: 440)
    .onAppear { focused = true }
    .onChange(of: query) { _, _ in selection = 0 }
    .task(id: query) { await search() }
  }

  private var entries: [Entry] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    let matches = { (text: String) in q.isEmpty || text.lowercased().contains(q) }
    var list: [Entry] = []
    let actions: [Entry] = [
      Entry(id: "new", title: "Nouveau fil", detail: "⌘N", symbol: "square.and.pencil") { app.startNewThread() },
      Entry(id: "project", title: "Nouveau projet…", detail: "⇧⌘N", symbol: "folder.badge.plus") { app.showNewProject = true },
      Entry(id: "review", title: "Afficher la revue", detail: "⌥⌘B", symbol: "sidebar.right") { app.showInspector = true; app.inspectorTab = .changes },
      Entry(id: "terminal", title: "Terminal", detail: "⌘J", symbol: "terminal") { app.showTerminal.toggle() },
      Entry(id: "plan", title: "Plan et tâches", detail: "", symbol: "list.bullet.clipboard") { app.showInspector = true; app.inspectorTab = .plan },
      Entry(id: "memory", title: "Mémoire du projet", detail: "", symbol: "brain") { app.showInspector = true; app.inspectorTab = .knowledge },
      Entry(id: "settings", title: "Réglages…", detail: "⌘,", symbol: "gearshape") { openSettings() },
    ]
    list += actions.filter { matches($0.title) }
    for project in app.projects where matches(project.name) && !q.isEmpty {
      list.append(Entry(id: "p\(project.id)", title: project.name, detail: project.path, symbol: "folder") { app.select(project: project.id) })
    }
    let rows = app.sessions.values.flatMap { $0 }.filter { !$0.archived && matches($0.displayTitle) }
    for row in rows.prefix(q.isEmpty ? 8 : 30) {
      list.append(Entry(id: "s\(row.id)", title: row.displayTitle, detail: [row.agent, relativeTime(row.updatedAt)].compactMap { $0 }.joined(separator: " · "), symbol: "bubble.left") {
        app.open(sessionId: row.id)
      })
    }
    for hit in hits {
      list.append(Entry(id: "h\(hit.id)", title: hit.plainSnippet, detail: hit.title ?? "Fil", symbol: "text.magnifyingglass") {
        app.open(sessionId: hit.sessionId)
        app.thread(hit.sessionId).focusItem = hit.itemId
      })
    }
    return list
  }

  private func execute(_ index: Int) {
    let list = entries
    guard list.indices.contains(index) else { return }
    dismiss()
    list[index].run()
  }

  private func search() async {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard q.count >= 2, let project = app.selectedProjectId, let client = app.client else { hits = []; return }
    try? await Task.sleep(nanoseconds: 250_000_000)
    guard !Task.isCancelled else { return }
    hits = (try? await client.search(project: project, query: q)) ?? []
  }
}
