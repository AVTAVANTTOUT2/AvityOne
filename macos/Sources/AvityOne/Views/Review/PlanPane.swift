import SwiftUI
import AvityKit

/// Specification and tasks of the thread's plan (dependencies, files, agent per task), the durable queue and the
/// persisted artefacts.
struct PlanPane: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  @State private var plan: Plan?
  @State private var jobs: [Job] = []
  @State private var queued = ""
  @State private var artifacts: String?
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let error { Text(error).foregroundStyle(Palette.red).font(.callout) }
        if let binding = Binding($plan) {
          GroupBox {
            TextEditor(text: binding.specification)
              .font(.callout)
              .frame(minHeight: 90)
              .scrollContentBackground(.hidden)
          } label: { Label("Spécification", systemImage: "doc.richtext") }

          GroupBox {
            VStack(alignment: .leading, spacing: 10) {
              if binding.wrappedValue.tasks.isEmpty { Text("Aucune tâche : le plan de l’agent ou la liste numérotée de sa dernière réponse apparaît ici.").font(.callout).foregroundStyle(.secondary) }
              ForEach(binding.tasks) { $task in
                TaskEditor(task: $task, agents: app.installedAgents, otherIds: binding.wrappedValue.tasks.map(\.id).filter { $0 != task.id },
                           move: { offset in move(task.id, offset) }, remove: { plan?.tasks.removeAll { $0.id == task.id } })
                Divider()
              }
              HStack {
                Button { addTask() } label: { Label("Ajouter une tâche", systemImage: "plus") }
                Spacer()
                Button("Enregistrer") { save(then: nil) }
                Button("Lancer la sélection en parallèle") { save { _ = try await $0.post("/sessions/\(thread.id)/parallel") } }
                  .buttonStyle(.borderedProminent)
                  .disabled(!binding.wrappedValue.tasks.contains { $0.selected })
              }
            }
          } label: { Label("Tâches (révision \(binding.wrappedValue.revision))", systemImage: "checklist") }
        } else {
          ProgressView()
        }

        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              TextField("Demande à mettre en file", text: $queued).textFieldStyle(.roundedBorder).onSubmit(queue)
              Button("Mettre en file", action: queue).disabled(queued.isEmpty)
            }
            if jobs.isEmpty { Text("File vide.").font(.callout).foregroundStyle(.secondary) }
            ForEach(jobs) { job in
              HStack {
                Text(job.taskId.map { "[\($0)] " } ?? "").font(.caption.monospaced()).foregroundStyle(.secondary)
                Text(job.prompt.prefix(120)).lineLimit(1).font(.callout)
                Spacer()
                Tag(text: ParallelRow.label(job.status), color: ParallelRow.color(job.status))
                if job.canRetry {
                  Button("Relancer") { app.run { _ = try await app.client?.post("/jobs/\(job.id)/retry"); await load() } }.buttonStyle(.borderless)
                }
              }
              if let error = job.error { Text(error).font(.caption).foregroundStyle(Palette.red).lineLimit(3) }
            }
          }
        } label: { Label("File d’exécution", systemImage: "tray.full") }

        GroupBox {
          VStack(alignment: .leading) {
            Button("Afficher spécification, plan et résultats persistants") {
              app.run { if let value: JSONValue = try await app.client?.get("/sessions/\(thread.id)/artifacts") { artifacts = value.pretty() } }
            }
            if let artifacts {
              ScrollView { Text(artifacts).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 260)
            }
          }
        } label: { Label("Artefacts", systemImage: "archivebox") }
      }
      .padding(14)
    }
    .task(id: "\(thread.id)-\(thread.planRevision)") { await load() }
    .onChange(of: thread.live.busy) { _, busy in if !busy { Task { await load() } } }
  }

  private func load() async {
    guard let client = app.client else { return }
    do {
      plan = try await client.plan(thread.id)
      jobs = try await client.jobs(thread.id)
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  private func addTask() {
    let ids = Set(plan?.tasks.map(\.id) ?? [])
    var n = (plan?.tasks.count ?? 0) + 1
    while ids.contains("task-\(n)") { n += 1 }
    plan?.tasks.append(PlanTask(id: "task-\(n)", content: "Nouvelle tâche"))
  }

  private func move(_ id: String, _ offset: Int) {
    guard var tasks = plan?.tasks, let index = tasks.firstIndex(where: { $0.id == id }) else { return }
    let target = index + offset
    guard tasks.indices.contains(target) else { return }
    tasks.swapAt(index, target)
    plan?.tasks = tasks
  }

  private func save(then next: ((APIClient) async throws -> Void)?) {
    guard let plan else { return }
    app.run {
      guard let client = app.client else { return }
      self.plan = try await client.savePlan(thread.id, plan)
      if let next { try await next(client); app.toast("Tâches mises en file.") } else { app.toast("Plan enregistré.") }
      await load()
    }
  }

  private func queue() {
    let text = queued.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return }
    app.run {
      _ = try await app.client?.prompt(session: thread.id, text: text, agent: nil, mode: nil, attachments: [], queue: true)
      queued = ""
      await load()
    }
  }
}

struct TaskEditor: View {
  @Binding var task: PlanTask
  var agents: [AgentSummary]
  var otherIds: [String]
  var move: (Int) -> Void
  var remove: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Toggle("", isOn: $task.selected).labelsHidden().toggleStyle(.checkbox)
        Text(task.id).font(.caption.monospaced()).foregroundStyle(.secondary)
        TextField("Tâche", text: $task.content).textFieldStyle(.roundedBorder)
        Button { move(-1) } label: { Image(systemName: "arrow.up") }.buttonStyle(.borderless)
        Button { move(1) } label: { Image(systemName: "arrow.down") }.buttonStyle(.borderless)
        Button(role: .destructive, action: remove) { Image(systemName: "trash") }.buttonStyle(.borderless)
      }
      HStack {
        Picker("Agent", selection: Binding(get: { task.agent ?? "" }, set: { task.agent = $0.isEmpty ? nil : $0 })) {
          Text("Routage").tag("")
          ForEach(agents) { Text($0.name).tag($0.id) }
        }
        .fixedSize()
        TextField("Fichiers (séparés par des virgules)", text: Binding(get: { task.files.joined(separator: ", ") }, set: { task.files = Self.list($0) }))
          .textFieldStyle(.roundedBorder)
      }
      .font(.caption)
      if !otherIds.isEmpty {
        HStack {
          Text("Dépend de").font(.caption).foregroundStyle(.secondary)
          ForEach(otherIds, id: \.self) { id in
            Toggle(id, isOn: Binding(get: { task.dependencies.contains(id) }, set: { on in
              if on { task.dependencies.append(id) } else { task.dependencies.removeAll { $0 == id } }
            }))
            .toggleStyle(.button)
            .font(.caption2)
          }
        }
      }
    }
  }

  static func list(_ text: String) -> [String] { text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
}
