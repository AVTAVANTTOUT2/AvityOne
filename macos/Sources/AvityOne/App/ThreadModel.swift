import AppKit
import SwiftUI
import UniformTypeIdentifiers
import AvityKit

/// One session (« fil »): its feed, live state, composer and the actions on it.
@MainActor @Observable final class ThreadModel: Identifiable {
  let id: String
  unowned let app: AppModel
  var session: SessionRow?
  var live = LiveState()
  var feed = Feed()
  var loaded = false
  var loading = false
  var error: String?
  let composer = ComposerState()
  /// Bumped by `plan` / `validation` events so open panels reload.
  var planRevision = 0
  var validationRevision = 0
  /// A history-search hit to scroll to.
  var focusItem: Int?
  /// A file to open in the Files tab (from the review).
  var focusFile: String?
  var git: GitStatus?

  @ObservationIgnored private var draftTask: Task<Void, Never>?
  @ObservationIgnored private var savedDraft = ""

  init(id: String, app: AppModel) {
    self.id = id
    self.app = app
  }

  var client: APIClient? { app.client }
  var title: String { session?.displayTitle ?? "Fil" }
  var project: Project? { app.projects.first { $0.id == session?.projectId } }
  /// Where the agent works: its worktree when isolated, otherwise the project folder.
  var workspacePath: String? { live.worktree ?? session?.worktree ?? project?.path }
  var planReady: Bool { !live.busy && live.mode == "plan" && feed.items.last?.itemType == .end }

  func load() async {
    guard let client else { return }
    loading = true
    defer { loading = false }
    do {
      let snapshot = try await client.snapshot(id)
      session = snapshot.session
      live = snapshot.state
      feed = Feed(items: snapshot.items)
      if !loaded {
        composer.text = snapshot.session.draft ?? ""
        savedDraft = composer.text
      }
      loaded = true
      error = nil
      for item in snapshot.items.reversed() where item.itemType == .permission {
        if item.isPendingPermission { app.pendingPermissions[id] = item }
        break
      }
      await refreshGit()
    } catch {
      self.error = error.localizedDescription
    }
  }

  func apply(_ item: Item) { feed.upsert(item) }

  func refreshGit() async {
    guard let client else { return }
    git = try? await client.gitStatus(id)
  }

  // MARK: Draft

  func draftChanged() {
    let text = composer.text
    guard text != savedDraft else { return }
    draftTask?.cancel()
    draftTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 600_000_000)
      guard !Task.isCancelled else { return }
      self?.saveDraftNow(text)
    }
  }

  func saveDraftNow(_ text: String) {
    guard let client, text != savedDraft else { return }
    savedDraft = text
    let id = self.id
    Task { try? await client.setDraft(id, text) }
  }

  // MARK: Actions

  func send() async { await app.send(composer, in: self) }

  func cancel() { app.run { [self] in _ = try await self.client?.post("/sessions/\(self.id)/cancel") } }

  func respond(_ item: Item, option: PermissionOption?) async {
    await app.respondPermission(session: id, permId: item.id, optionId: option?.id)
  }

  func setConfig(_ option: ConfigOption, _ value: JSONValue) {
    app.run { [self] in
      guard let client else { return }
      self.live = try await client.setConfig(session: self.id, configId: option.id, value: value)
    }
  }

  func setAutoApprove(_ on: Bool) {
    app.run { [self] in
      guard let client else { return }
      self.live = try await client.setAutoApprove(session: self.id, on)
    }
  }

  func setIsolated(_ on: Bool) {
    app.run { [self] in
      guard let client else { return }
      self.live = try await client.setIsolated(session: self.id, on)
    }
  }

  func execute(agent: String?) {
    app.run { [self] in
      var body: [String: JSONValue] = [:]
      if let agent, agent != "auto" { body["agent"] = .string(agent) }
      _ = try await self.client?.post("/sessions/\(self.id)/execute", .object(body))
    }
  }

  func parallel() { app.run { [self] in _ = try await self.client?.post("/sessions/\(self.id)/parallel") } }

  func review(agent: String? = nil) {
    app.run { [self] in _ = try await self.client?.post("/sessions/\(self.id)/review", agent.map { ["agent": .string($0)] } ?? [:]) }
  }

  func summarize() {
    app.run { [self] in
      let result = try await self.client?.post("/sessions/\(self.id)/summarize")
      if result?["skipped"]?.bool == true { self.app.toast("Rien de nouveau à résumer.") } else { self.app.toast("Résumé et mémoire mis à jour.") }
      await self.app.loadSessions(self.session?.projectId ?? 0)
    }
  }

  func regenerate(agent: String?) {
    app.run { [self] in _ = try await self.client?.post("/sessions/\(self.id)/regenerate", agent.map { ["agent": .string($0)] } ?? [:]) }
  }

  func retry() {
    guard let last = feed.items.last(where: { $0.itemType == .user }) else { return }
    regenerate(agent: last.agent)
  }

  func fork(before: Int?) {
    app.run { [self] in
      guard let client else { return }
      let row = try await client.fork(session: self.id, before: before)
      await self.app.loadSessions(row.projectId ?? self.session?.projectId ?? 0)
      self.app.select(session: row.id)
    }
  }

  func edit(_ item: Item, text: String, fork: Bool) {
    app.run { [self] in
      guard let client else { return }
      let result = try await client.edit(session: self.id, itemId: item.id, text: text, fork: fork)
      if let other = result.sessionId, other != self.id {
        await self.app.loadSessions(self.session?.projectId ?? 0)
        self.app.select(session: other)
      }
    }
  }

  func rename(_ title: String) { update(["title": .string(title)]) }
  func setPinned(_ pinned: Bool) { update(["pinned": .bool(pinned)]) }
  func setArchived(_ archived: Bool) { update(["archived": .bool(archived)]) }

  private func update(_ patch: JSONValue) {
    app.run { [self] in
      guard let client else { return }
      self.session = try await client.updateSession(self.id, patch)
      await self.app.loadSessions(self.session?.projectId ?? 0)
    }
  }

  func delete() {
    app.run { [self] in
      guard let client else { return }
      let project = self.session?.projectId
      try await client.deleteSession(self.id)
      if self.app.selectedSessionId == self.id { self.app.selectedSessionId = nil }
      self.app.threads[self.id] = nil
      if let project { await self.app.loadSessions(project) }
    }
  }

  func exportMarkdown() {
    app.run { [self] in
      guard let client else { return }
      let exported = try await client.export(self.id)
      let panel = NSSavePanel()
      panel.nameFieldStringValue = exported.filename
      panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
      if panel.runModal() == .OK, let url = panel.url { try Data(exported.markdown.utf8).write(to: url) }
    }
  }

  // MARK: Git

  func commit(message: String, all: Bool) async -> Bool {
    guard let client else { return false }
    do { git = try await client.commit(id, message: message, all: all); app.toast("Commit créé."); return true }
    catch { app.toast(error.localizedDescription, error: true); return false }
  }

  func push() async {
    guard let client else { return }
    do { git = try await client.push(id); app.toast("Branche poussée vers origin.") }
    catch { app.toast(error.localizedDescription, error: true) }
  }

  func pullRequest(title: String, body: String) async -> URL? {
    guard let client else { return nil }
    do {
      let result = try await client.pullRequest(id, title: title, body: body)
      app.toast("Pull request créée.")
      return result.url.flatMap(URL.init(string:))
    } catch { app.toast(error.localizedDescription, error: true); return nil }
  }
}
