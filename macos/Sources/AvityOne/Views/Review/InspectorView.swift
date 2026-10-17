import SwiftUI
import AvityKit

struct InspectorView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var app = app
    VStack(spacing: 0) {
      Picker("", selection: $app.inspectorTab) {
        ForEach(InspectorTab.allCases) { tab in Label(tab.label, systemImage: tab.symbol).tag(tab) }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(10)
      Divider()
      Group {
        if let thread = app.selectedThread {
          switch app.inspectorTab {
          case .changes: ChangesPane(thread: thread)
          case .merge: MergePane(thread: thread)
          case .plan: PlanPane(thread: thread)
          case .files: FilesPane(thread: thread)
          case .knowledge: KnowledgePane(project: thread.session?.projectId ?? app.selectedProjectId ?? 0)
          case .context: ContextPane(thread: thread)
          }
        } else if app.inspectorTab == .knowledge, let project = app.selectedProjectId {
          KnowledgePane(project: project)
        } else {
          ContentUnavailableView("Ouvre un fil", systemImage: "sidebar.right", description: Text("La revue, la fusion, le plan et les fichiers portent sur le fil sélectionné."))
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

/// Codex's review pane: unstaged, staged and new files, select or revert by file or hunk, comment a line back to the
/// agent, then commit, push and open a pull request.
struct ChangesPane: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  @State private var unstaged: WorkspaceDiff?
  @State private var staged: WorkspaceDiff?
  @State private var error: String?
  @State private var loading = false
  @State private var commitMessage = ""
  @State private var commitAll = true
  @State private var comment: (path: String, line: DiffLine)?
  @State private var commentText = ""
  @State private var showPR = false
  @State private var confirmRevert: (path: String, hunk: Int?)?

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      if let error {
        ContentUnavailableView { Label("Changements indisponibles", systemImage: "exclamationmark.triangle") } description: { Text(error) } actions: {
          Button("Réessayer") { Task { await load() } }
        }
      } else if unstaged == nil {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            section("Indexé", diff: staged, staged: true)
            section("Non indexé", diff: unstaged, staged: false)
            if let untracked = unstaged?.untracked, !untracked.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                Text("Nouveaux fichiers").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(untracked, id: \.self) { path in
                  HStack {
                    Image(systemName: "doc.badge.plus").foregroundStyle(Palette.green)
                    Text(path).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button("Indexer") { select(path: path, hunk: nil, action: "accept", staged: false) }.buttonStyle(.borderless)
                  }
                }
              }
              .padding(.horizontal, 12)
            }
            if (staged?.files.isEmpty ?? true) && (unstaged?.files.isEmpty ?? true) && (unstaged?.untracked.isEmpty ?? true) {
              ContentUnavailableView("Aucun changement", systemImage: "checkmark.circle", description: Text(cleanHint))
            }
          }
          .padding(.vertical, 12)
        }
        Divider()
        commitBar
      }
    }
    .task(id: thread.id) { await load() }
    .onChange(of: thread.live.busy) { _, busy in if !busy { Task { await load() } } }
    .sheet(isPresented: $showPR) { PullRequestSheet(thread: thread) }
    .alert(commentTitle, isPresented: Binding(get: { comment != nil }, set: { if !$0 { comment = nil } })) {
      TextField("Ce qu’il faut changer", text: $commentText)
      Button("Envoyer à l’agent") { sendComment() }
      Button("Annuler", role: .cancel) {}
    } message: { Text(comment?.line.text ?? "") }
    .confirmationDialog("Annuler cette modification locale ?", isPresented: Binding(get: { confirmRevert != nil }, set: { if !$0 { confirmRevert = nil } })) {
      Button("Annuler la modification", role: .destructive) {
        if let target = confirmRevert { select(path: target.path, hunk: target.hunk, action: "reject", staged: false) }
      }
    } message: { Text("Le contenu modifié sera perdu.") }
  }

  private var commentTitle: String {
    guard let comment else { return "Commenter" }
    return "Commenter \(comment.path)" + (comment.line.newNumber.map { ":\($0)" } ?? "")
  }

  private var cleanHint: String {
    let ahead: Int = thread.git?.ahead ?? 0
    return ahead > 0 ? "\(ahead) commit(s) à pousser." : "Le dossier de travail est propre."
  }

  private var header: some View {
    HStack(spacing: 8) {
      if let git = thread.git {
        Label(git.branch ?? "HEAD détaché", systemImage: "arrow.triangle.branch").font(.callout.weight(.medium))
        if git.ahead > 0 { Tag(text: "↑\(git.ahead)", color: Palette.accentInk) }
        if git.behind > 0 { Tag(text: "↓\(git.behind)", color: Palette.amber) }
        if git.upstream == nil && git.remote != nil { Tag(text: "non publiée", color: .secondary) }
      } else {
        Label("Pas de dépôt git", systemImage: "folder").font(.callout).foregroundStyle(.secondary)
      }
      Spacer()
      if loading { ProgressView().controlSize(.small) }
      Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).help("Actualiser")
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
  }

  private var commitBar: some View {
    VStack(alignment: .leading, spacing: 8) {
      TextField("Message de commit", text: $commitMessage, axis: .vertical)
        .lineLimit(1...4)
        .textFieldStyle(.roundedBorder)
      HStack {
        Toggle("Tout inclure", isOn: $commitAll).toggleStyle(.checkbox).help("Sinon, seules les modifications indexées sont commitées")
        Spacer()
        Button("Commit") {
          Task { if await thread.commit(message: commitMessage, all: commitAll) { commitMessage = ""; await load() } }
        }
        .disabled(commitMessage.trimmingCharacters(in: .whitespaces).isEmpty)
        Button("Push") { Task { await thread.push(); await load() } }
          .disabled(thread.git?.branch == nil || thread.git?.remote == nil)
        Button("Créer une PR…") { showPR = true }
          .disabled(thread.git?.upstream == nil)
          .help(thread.git?.github == false ? "Installe GitHub CLI (gh) et connecte-le avec « gh auth login »" : "Ouvre une pull request avec gh")
      }
    }
    .padding(12)
  }

  @ViewBuilder private func section(_ title: String, diff: WorkspaceDiff?, staged: Bool) -> some View {
    if let diff, !diff.files.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
          Spacer()
          Text("\(diff.files.count) fichier\(diff.files.count > 1 ? "s" : "")").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        ForEach(DiffParser.files(from: diff.hunks)) { file in
          FileDiffCard(file: file, staged: staged,
                       onSelect: { hunk in select(path: file.path, hunk: hunk, action: staged ? "reject" : "accept", staged: staged) },
                       onRevert: staged ? nil : { hunk in confirmRevert = (file.path, hunk) },
                       onComment: { line in commentText = ""; comment = (file.path, line) },
                       openFile: { app.inspectorTab = .files; thread.focusFile = file.path })
        }
      }
    }
  }

  private func load() async {
    guard let client = app.client else { return }
    loading = true
    defer { loading = false }
    await thread.refreshGit()
    guard thread.git != nil else { error = "Ce dossier n’est pas un dépôt git : la revue des changements s’appuie sur git."; return }
    do {
      async let u = client.diff(thread.id, staged: false)
      async let s = client.diff(thread.id, staged: true)
      unstaged = try await u
      staged = try await s
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  private func select(path: String, hunk: Int?, action: String, staged: Bool) {
    guard let diff = staged ? self.staged : unstaged else { return }
    app.run {
      guard let client = app.client else { return }
      _ = try await client.selectChange(thread.id, path: path, hunk: hunk, action: action, revision: diff.revision, staged: staged)
      await load()
    }
  }

  private func sendComment() {
    guard let comment, !commentText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    let line = comment.line.newNumber.map { ":\($0)" } ?? ""
    thread.composer.text = "Dans `\(comment.path)\(line)` (`\(comment.line.text.trimmingCharacters(in: .whitespaces))`) : \(commentText)"
    Task { await thread.send() }
  }
}

struct FileDiffCard: View {
  var file: DiffFile
  var staged: Bool
  var onSelect: (Int?) -> Void
  var onRevert: ((Int?) -> Void)?
  var onComment: (DiffLine) -> Void
  var openFile: () -> Void
  @State private var open = true

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Button { withAnimation(.snappy) { open.toggle() } } label: {
          Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(open ? 90 : 0))
        }.buttonStyle(.borderless)
        Image(systemName: file.status == .added ? "doc.badge.plus" : file.status == .deleted ? "trash" : "doc.text")
          .foregroundStyle(file.status == .added ? Palette.green : file.status == .deleted ? Palette.red : .secondary)
        Button(action: openFile) { Text(file.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle) }.buttonStyle(.plain)
        Spacer()
        Text("+\(file.additions)").foregroundStyle(Palette.green).font(.caption.monospaced())
        Text("−\(file.deletions)").foregroundStyle(Palette.red).font(.caption.monospaced())
        Button(staged ? "Désindexer" : "Indexer") { onSelect(nil) }.buttonStyle(.borderless).font(.caption)
        if let onRevert { Button { onRevert(nil) } label: { Image(systemName: "arrow.uturn.backward") }.buttonStyle(.borderless).help("Annuler les modifications du fichier") }
      }
      .padding(.horizontal, 10).padding(.vertical, 6)
      if open {
        ForEach(file.hunks) { hunk in
          VStack(alignment: .leading, spacing: 0) {
            HStack {
              Text(hunk.header).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
              Spacer()
              if let index = hunk.index {
                Button(staged ? "Désindexer le bloc" : "Indexer le bloc") { onSelect(index) }.buttonStyle(.borderless).font(.caption2)
                if let onRevert { Button("Annuler le bloc") { onRevert(index) }.buttonStyle(.borderless).font(.caption2) }
              }
            }
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(Palette.raised)
            ScrollView(.horizontal) { DiffLinesView(lines: hunk.lines, onComment: onComment).frame(minWidth: 460) }
          }
        }
      }
    }
    .background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .padding(.horizontal, 12)
  }
}

struct PullRequestSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var thread: ThreadModel
  @State private var title = ""
  @State private var body_ = ""
  @State private var working = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Créer une pull request").font(.title3.weight(.semibold))
      Text("Avec GitHub CLI, depuis \(thread.git?.branch ?? "la branche courante").").font(.callout).foregroundStyle(.secondary)
      TextField("Titre", text: $title).textFieldStyle(.roundedBorder)
      TextEditor(text: $body_).font(.body).frame(height: 160).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
      HStack {
        if working { ProgressView().controlSize(.small) }
        Spacer()
        Button("Annuler") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Créer") {
          working = true
          Task {
            if let url = await thread.pullRequest(title: title, body: body_) { NSWorkspace.shared.open(url) }
            working = false
            dismiss()
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(title.isEmpty || working)
      }
    }
    .padding(20)
    .frame(width: 520)
    .onAppear { title = thread.session?.displayTitle ?? ""; body_ = thread.session?.summary ?? "" }
  }
}

/// « Ouvrir dans » companion: commit, push and PR from the toolbar.
struct GitMenu: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  var body: some View {
    Menu {
      Button("Voir les changements") { app.inspectorTab = .changes; app.showInspector = true }
      Button("Pousser la branche") { Task { await thread.push() } }.disabled(thread.git?.branch == nil || thread.git?.remote == nil)
      Button("Valider : tests, lint, build") { app.inspectorTab = .merge; app.showInspector = true }
      if thread.live.isolated || thread.live.worktree != nil {
        Button("Fusionner le worktree…") { app.inspectorTab = .merge; app.showInspector = true }
      }
    } label: {
      Label(thread.git?.branch ?? "Git", systemImage: "arrow.triangle.branch")
    }
    .help("Git : changements, push, validation et fusion")
  }
}
