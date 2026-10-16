import AppKit
import SwiftUI
import AvityKit

struct Toast: Identifiable, Equatable {
  let id = UUID()
  var text: String
  var error: Bool
}

enum InspectorTab: String, CaseIterable, Identifiable {
  case changes, merge, plan, files, knowledge, context
  var id: String { rawValue }
  var label: String {
    switch self {
    case .changes: "Changements"
    case .merge: "Fusion"
    case .plan: "Plan"
    case .files: "Fichiers"
    case .knowledge: "Mémoire"
    case .context: "Contexte"
    }
  }
  var symbol: String {
    switch self {
    case .changes: "plusminus"
    case .merge: "arrow.triangle.merge"
    case .plan: "list.bullet.clipboard"
    case .files: "folder"
    case .knowledge: "brain"
    case .context: "text.alignleft"
    }
  }
}

/// Root state: the connection to an engine (embedded or remote), projects, sessions and their activity, and the
/// event stream that keeps all of it live.
@MainActor @Observable final class AppModel {
  static let shared = AppModel()

  enum Connection: Equatable {
    case idle
    case starting(String)
    case ready
    case failed(String)
    case unauthorized
  }

  let preferences = Preferences.shared
  let engine = EngineController.shared
  var connection: Connection = .idle
  var link: EventStream.Link = .connecting
  @ObservationIgnored private(set) var client: APIClient?
  @ObservationIgnored private var stream: EventStream?
  private(set) var endpoint: EngineController.Endpoint?

  var agents: [AgentSummary] = []
  var projects: [Project] = []
  var selectedProjectId: Int? { didSet { if let id = selectedProjectId { preferences.lastProject[preferences.activeProfileId.uuidString] = id } } }
  var sessions: [Int: [SessionRow]] = [:]
  var activity: [String: SessionActivity] = [:]
  var selectedSessionId: String?
  var threads: [String: ThreadModel] = [:]
  /// Pending permission per session, kept from SSE items even for sessions never opened (notifications, menu bar).
  var pendingPermissions: [String: Item] = [:]
  let newThread = ComposerState()

  var toasts: [Toast] = []
  var showInspector = false
  var inspectorTab: InspectorTab = .changes
  var showTerminal = false
  var showPalette = false
  var showNewProject = false
  var showOnboarding = false
  var focusComposer = 0

  @ObservationIgnored private var pending: [ServerEvent] = []
  @ObservationIgnored private var flushScheduled = false
  @ObservationIgnored private var sessionsReload: Set<Int> = []
  @ObservationIgnored private var restarts: [Date] = []

  var isLocal: Bool { preferences.activeProfile.isLocal }
  var selectedProject: Project? { projects.first { $0.id == selectedProjectId } }
  var selectedThread: ThreadModel? { selectedSessionId.flatMap { threads[$0] } }
  var installedAgents: [AgentSummary] { agents.filter(\.installed) }

  // MARK: Connection

  func boot() async {
    Notifier.shared.onOpen = { [weak self] id in self?.open(sessionId: id) }
    Notifier.shared.onPermission = { [weak self] session, perm, option in
      Task { await self?.respondPermission(session: session, permId: perm, optionId: option) }
    }
    engine.onUnexpectedExit = { message in
      DispatchQueue.main.async { MainActor.assumeIsolated { AppModel.shared.engineExited(message) } }
    }
    await connect()
    if connection == .ready && isLocal && !preferences.onboardingDone { showOnboarding = true }
  }

  func connect() async {
    stream?.stop()
    stream = nil
    client = nil
    threads = [:]
    sessions = [:]
    activity = [:]
    pendingPermissions = [:]
    selectedSessionId = nil
    let profile = preferences.activeProfile
    do {
      if profile.isLocal {
        connection = .starting("Démarrage du moteur local…")
        let endpoint = try await engine.start(preferredPort: preferences.enginePort)
        self.endpoint = endpoint
        preferences.enginePort = endpoint.port
        client = APIClient(baseURL: endpoint.url, token: endpoint.token)
      } else {
        connection = .starting("Connexion à \(profile.name)…")
        guard let url = ServerProfile.normalize(profile.url) else { throw APIError(status: 0, message: "Adresse du serveur invalide : \(profile.url)") }
        guard let token = Keychain.token(for: profile.id), !token.isEmpty else { connection = .unauthorized; return }
        endpoint = nil
        client = APIClient(baseURL: url, token: token)
      }
      try await refreshState()
      startStream()
      connection = .ready
    } catch let error as APIError where error.status == 401 {
      connection = .unauthorized
    } catch {
      connection = .failed(error.localizedDescription)
    }
  }

  func switchProfile(_ id: UUID) async {
    guard id != preferences.activeProfileId else { return }
    if isLocal { await Task.detached { EngineController.shared.stop() }.value }
    preferences.activeProfileId = id
    await connect()
  }

  func restartEngine() async {
    guard isLocal else { await connect(); return }
    await Task.detached { EngineController.shared.stop() }.value
    await connect()
  }

  private func engineExited(_ message: String) {
    guard isLocal, connection == .ready || connection == .idle else { return }
    restarts = restarts.filter { Date().timeIntervalSince($0) < 120 } + [Date()]
    if restarts.count > 3 { connection = .failed(message); return }
    toast("Le moteur s’est arrêté : redémarrage…", error: true)
    Task { await connect() }
  }

  private func startStream() {
    guard let client else { return }
    let stream = EventStream(client: client, onEvent: { event in
      DispatchQueue.main.async { MainActor.assumeIsolated { AppModel.shared.enqueue(event) } }
    }, onLink: { link in
      DispatchQueue.main.async { MainActor.assumeIsolated { AppModel.shared.linkChanged(link) } }
    }, onReconnect: {
      Task { @MainActor in await AppModel.shared.resync() }
    })
    self.stream = stream
    stream.start()
  }

  private func linkChanged(_ link: EventStream.Link) {
    self.link = link
    if link == .unauthorized { connection = .unauthorized; stream?.stop() }
  }

  func refreshState() async throws {
    guard let client else { return }
    let state = try await client.state()
    agents = state.agents
    projects = state.projects
    var seeded: [String: SessionActivity] = [:]
    for live in state.activity { seeded[live.sessionId] = SessionActivity(projectId: live.projectId, busy: live.busy, waiting: live.waiting) }
    // A session that was busy and no longer is finished while the stream was down.
    for (id, old) in activity where old.busy && seeded[id] == nil { seeded[id] = SessionActivity(projectId: old.projectId, unread: .done) }
    for (id, old) in activity where seeded[id] == nil && old.unread != nil { seeded[id] = old }
    activity = seeded
    if selectedProjectId == nil || !projects.contains(where: { $0.id == selectedProjectId }) {
      let remembered = preferences.lastProject[preferences.activeProfileId.uuidString]
      selectedProjectId = projects.first { $0.id == remembered }?.id ?? projects.first?.id
    }
    if let project = selectedProjectId { await loadSessions(project) }
    updateBadge()
  }

  private func resync() async {
    try? await refreshState()
    for project in sessions.keys where project != selectedProjectId { await loadSessions(project) }
    for thread in threads.values where thread.loaded { await thread.load() }
  }

  func loadSessions(_ project: Int) async {
    guard let client else { return }
    do {
      let rows = try await client.sessions(project: project)
      sessions[project] = rows
      for row in rows where row.busy || row.waiting {
        var a = activity[row.id] ?? SessionActivity(projectId: project)
        a.busy = row.busy; a.waiting = row.waiting
        activity[row.id] = a
      }
    } catch { toast(error.localizedDescription, error: true) }
  }

  // MARK: Events

  private func enqueue(_ event: ServerEvent) {
    pending.append(event)
    guard !flushScheduled else { return }
    flushScheduled = true
    // Streaming text arrives in bursts: apply them together, about once per frame.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { MainActor.assumeIsolated { AppModel.shared.flush() } }
  }

  private func flush() {
    flushScheduled = false
    let events = pending
    pending = []
    for event in events { handle(event) }
    for project in sessionsReload { Task { await loadSessions(project) } }
    sessionsReload = []
    updateBadge()
  }

  func handle(_ event: ServerEvent) {
    switch event {
    case .item(let sessionId, _, let item):
      if item.itemType == .permission {
        if item.isPendingPermission { pendingPermissions[sessionId] = item } else if pendingPermissions[sessionId]?.id == item.id { pendingPermissions[sessionId] = nil }
      }
      threads[sessionId]?.apply(item)
    case .state(let sessionId, let projectId, let state):
      var a = activity[sessionId] ?? SessionActivity(projectId: projectId)
      a.busy = state.busy
      a.waiting = state.waiting
      activity[sessionId] = a
      if !state.waiting { pendingPermissions[sessionId] = nil }
      threads[sessionId]?.live = state
    case .activity(let event):
      notify(event)
    case .sessions(let projectId):
      if sessions[projectId] != nil || projectId == selectedProjectId { sessionsReload.insert(projectId) }
    case .reset(let sessionId, _, let fromId):
      threads[sessionId]?.feed.reset(from: fromId)
    case .plan(let sessionId, _):
      threads[sessionId]?.planRevision += 1
    case .validation(let sessionId, _):
      threads[sessionId]?.validationRevision += 1
    case .unknown:
      break
    }
  }

  private func notify(_ event: ActivityEvent) {
    let visible = NSApp.isActive && selectedSessionId == event.sessionId
    if event.kind != "waiting" && !visible {
      var a = activity[event.sessionId] ?? SessionActivity(projectId: event.projectId)
      a.unread = event.kind == "error" ? .error : .done
      activity[event.sessionId] = a
    }
    let agent = agents.first { $0.id == event.agent }?.name ?? event.agent ?? "Agent"
    let title = event.title ?? "Fil sans titre"
    let heading: String
    switch event.kind {
    case "waiting": heading = "\(agent) attend ta validation"
    case "error": heading = "\(agent) a échoué"
    default: heading = "\(agent) a terminé"
    }
    if preferences.sounds && NSApp.isActive && !visible { NSSound(named: NSSound.Name(event.kind == "waiting" ? "Glass" : event.kind == "error" ? "Basso" : "Pop"))?.play() }
    let shouldNotify: Bool
    switch preferences.notifyWhen {
    case .never: shouldNotify = false
    case .always: shouldNotify = !visible
    case .background: shouldNotify = !NSApp.isActive
    }
    if shouldNotify {
      var actions: Notifier.PermissionActions?
      if event.kind == "waiting", let item = pendingPermissions[event.sessionId], let options = item.options {
        actions = Notifier.PermissionActions(permId: item.id, allow: options.first { $0.kind == "allow_once" }?.id ?? options.first(where: \.isAllow)?.id,
                                             deny: options.first { $0.kind == "reject_once" }?.id ?? options.first { !$0.isAllow }?.id)
      }
      Notifier.shared.post(title: heading, body: "\(title) — \(event.text)", sessionId: event.sessionId, permission: actions, sound: preferences.sounds)
    } else if NSApp.isActive && !visible {
      toast("\(heading) : \(title)", error: event.kind == "error")
    }
  }

  func updateBadge() {
    let count = activity.values.filter { $0.waiting || $0.unread != nil }.count
    NSApp?.dockTile.badgeLabel = count > 0 ? String(count) : nil
  }

  // MARK: Navigation

  func thread(_ id: String) -> ThreadModel {
    if let existing = threads[id] { return existing }
    let created = ThreadModel(id: id, app: self)
    threads[id] = created
    return created
  }

  func select(project id: Int?) {
    guard id != selectedProjectId else { return }
    selectedProjectId = id
    selectedSessionId = nil
    if let id, sessions[id] == nil { Task { await loadSessions(id) } }
  }

  func select(session id: String?) {
    selectedSessionId = id
    guard let id else { return }
    markSeen(id)
    let thread = thread(id)
    if !thread.loaded { Task { await thread.load() } }
  }

  func markSeen(_ id: String) {
    if activity[id]?.unread != nil { activity[id]?.unread = nil; updateBadge() }
    Notifier.shared.clear(sessionId: id)
  }

  func open(sessionId: String) {
    if let project = sessions.first(where: { $0.value.contains { $0.id == sessionId } })?.key ?? activity[sessionId]?.projectId { select(project: project) }
    select(session: sessionId)
  }

  func startNewThread() {
    selectedSessionId = nil
    newThread.isolated = preferences.newThreadsIsolated
    focusComposer += 1
  }

  /// Sessions of the selected project in sidebar order, for ⌥↑ / ⌥↓.
  func moveSelection(_ offset: Int) {
    guard let project = selectedProjectId, let rows = sessions[project]?.filter({ !$0.archived && $0.parentId == nil }), !rows.isEmpty else { return }
    let index = rows.firstIndex { $0.id == selectedSessionId } ?? (offset > 0 ? -1 : rows.count)
    let next = min(max(index + offset, 0), rows.count - 1)
    select(session: rows[next].id)
  }

  func toast(_ text: String, error: Bool = false) {
    let toast = Toast(text: text, error: error)
    toasts.append(toast)
    DispatchQueue.main.asyncAfter(deadline: .now() + (error ? 6 : 3.5)) {
      MainActor.assumeIsolated { AppModel.shared.toasts.removeAll { $0.id == toast.id } }
    }
  }

  /// Runs an action and reports its failure as a toast.
  func run(_ action: @escaping () async throws -> Void) {
    Task {
      do { try await action() } catch { toast(error.localizedDescription, error: true) }
    }
  }

  // MARK: Actions spanning sessions

  func respondPermission(session: String, permId: Int, optionId: String?) async {
    guard let client else { return }
    do { try await client.respondPermission(session: session, permId: permId, optionId: optionId) }
    catch { toast(error.localizedDescription, error: true) }
  }

  /// Sends the composer: creates the session first for a new thread, then uploads attachments and queues the prompt.
  func send(_ composer: ComposerState, in thread: ThreadModel?) async {
    guard let client, let project = selectedProjectId ?? thread?.session?.projectId else { return }
    let text = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || !composer.attachments.isEmpty else { return }
    composer.sending = true
    defer { composer.sending = false }
    do {
      var target = thread
      if target == nil {
        let row = try await client.createSession(project: project, isolated: composer.isolated)
        target = self.thread(row.id)
        await loadSessions(project)
        selectedSessionId = row.id
        await target?.load()
      }
      guard let target else { return }
      var ids: [String] = []
      for attachment in composer.attachments {
        ids.append(try await client.uploadAttachment(session: target.id, name: attachment.name, mime: attachment.mime, data: attachment.data).id)
      }
      let busy = target.live.busy
      _ = try await client.prompt(session: target.id, text: text.isEmpty ? "Analyse les pièces jointes." : text,
                                  agent: composer.agent, mode: composer.mode.isEmpty ? nil : composer.mode, attachments: ids, queue: busy)
      if busy { toast("Message mis en file : il partira à la fin du tour en cours.") }
      composer.text = ""
      composer.attachments = []
      target.saveDraftNow("")
    } catch { toast(error.localizedDescription, error: true) }
  }

  func createProject(name: String, path: String?, git: String?) async -> Bool {
    guard let client else { return false }
    do {
      let project = try await client.createProject(name: name, path: path, git: git)
      try await refreshState()
      select(project: project.id)
      startNewThread()
      return true
    } catch { toast(error.localizedDescription, error: true); return false }
  }

  struct LiveSession: Identifiable {
    var id: String
    var row: SessionRow?
    var activity: SessionActivity
  }

  func waitingSessions() -> [LiveSession] {
    activity.filter { $0.value.busy || $0.value.waiting }.map { entry in
      LiveSession(id: entry.key, row: sessions[entry.value.projectId]?.first { $0.id == entry.key }, activity: entry.value)
    }.sorted { ($0.activity.signal ?? .done) > ($1.activity.signal ?? .done) }
  }

  var anyBusy: Bool { activity.values.contains { $0.busy } }
}

/// The message being written, for a new thread or an existing one.
@MainActor @Observable final class ComposerState {
  struct Attachment: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var mime: String
    var data: Data
  }
  var text = ""
  var agent = "auto"
  /// "" lets AvityOne route (`/plan` and mentions included), otherwise "agent" or "plan".
  var mode = ""
  var attachments: [Attachment] = []
  var isolated = false
  var sending = false

  static let maxFiles = 8
  static let maxBytes = 5 * 1024 * 1024

  func attach(url: URL) -> String? {
    guard attachments.count < Self.maxFiles else { return "8 pièces jointes au plus." }
    guard let data = try? Data(contentsOf: url) else { return "Lecture impossible : \(url.lastPathComponent)" }
    guard data.count <= Self.maxBytes else { return "\(url.lastPathComponent) dépasse 5 Mio." }
    attachments.append(Attachment(name: String(url.lastPathComponent.prefix(200)), mime: Self.mime(for: url), data: data))
    return nil
  }

  func attach(image data: Data, name: String) -> String? {
    guard attachments.count < Self.maxFiles else { return "8 pièces jointes au plus." }
    guard data.count <= Self.maxBytes else { return "\(name) dépasse 5 Mio." }
    attachments.append(Attachment(name: name, mime: "image/png", data: data))
    return nil
  }

  static func mime(for url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "png": "image/png"
    case "jpg", "jpeg": "image/jpeg"
    case "gif": "image/gif"
    case "webp": "image/webp"
    case "pdf": "application/pdf"
    case "md", "markdown": "text/markdown"
    case "txt", "log": "text/plain"
    case "json": "application/json"
    case "csv": "text/csv"
    case "html", "htm": "text/html"
    case "mp3": "audio/mpeg"
    case "wav": "audio/wav"
    case "m4a": "audio/mp4"
    case "swift", "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "kt", "c", "h", "cpp", "rb", "sh", "yml", "yaml", "toml", "css", "sql": "text/plain"
    default: "application/octet-stream"
    }
  }
}
