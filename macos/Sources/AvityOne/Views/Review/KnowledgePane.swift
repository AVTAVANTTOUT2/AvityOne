import SwiftUI
import UniformTypeIdentifiers
import AvityKit

/// The project's shared memory (what every agent learns), indexed sources, imported documents, brief and AGENTS.md.
struct KnowledgePane: View {
  @Environment(AppModel.self) private var app
  var project: Int
  @State private var query = ""
  @State private var knowledge: KnowledgeList?
  @State private var kind = "decision"
  @State private var newText = ""
  @State private var documents: ProjectDocuments?
  @State private var brief = ""
  @State private var instructions = ""
  @State private var busy: String?

  struct Kind: Identifiable { var id: String; var label: String }
  static let kinds = [Kind(id: "decision", label: "Décision"), Kind(id: "convention", label: "Convention"), Kind(id: "pitfall", label: "Piège"),
                      Kind(id: "fact", label: "Fait"), Kind(id: "todo", label: "À faire")]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          TextField("Rechercher dans la mémoire et les sources", text: $query).textFieldStyle(.roundedBorder).onSubmit { Task { await load() } }
          if let busy { ProgressView().controlSize(.small).help(busy) }
        }
        HStack {
          Button("Réindexer") { act("Indexation…") { _ = try await $0.post("/projects/\(project)/reindex") } }
          Button("Consolider") { act("Consolidation…") { _ = try await $0.post("/projects/\(project)/memory/consolidate") } }
          Button("Importer un document…") { importDocument() }
          Button("Exporter en Markdown…") { exportMarkdown() }
        }
        .controlSize(.small)

        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Picker("", selection: $kind) { ForEach(Self.kinds) { Text($0.label).tag($0.id) } }.labelsHidden().fixedSize()
              TextField("Nouvelle connaissance durable", text: $newText).textFieldStyle(.roundedBorder).onSubmit(add)
              Button("Ajouter", action: add).disabled(newText.isEmpty)
            }
            ForEach(knowledge?.memory ?? []) { memory in
              HStack(alignment: .top) {
                Tag(text: Self.kinds.first { $0.id == memory.kind }?.label ?? memory.kind, color: color(memory.kind))
                Text(memory.text).font(.callout).textSelection(.enabled)
                Spacer()
                if memory.stale { Tag(text: "périmé", color: Palette.amber) }
                if !memory.contradictions.isEmpty { Tag(text: "contradiction", color: Palette.red) }
                Button { act("Suppression…") { try await $0.deleteMemory(project: project, id: memory.id) } } label: { Image(systemName: "trash") }
                  .buttonStyle(.borderless)
              }
            }
            if knowledge?.memory.isEmpty == true { Text("Rien de mémorisé pour l’instant : les résumés de sessions alimentent la mémoire.").font(.callout).foregroundStyle(.secondary) }
          }
        } label: { Label("Mémoire partagée (\(knowledge?.memory.count ?? 0))", systemImage: "brain") }

        GroupBox {
          VStack(alignment: .leading, spacing: 4) {
            ForEach((knowledge?.docs ?? []).prefix(60)) { doc in
              HStack {
                Image(systemName: "doc.text").foregroundStyle(.secondary)
                Text(doc.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                Spacer()
                if let characters = doc.characters { Text("\(characters) car.").font(.caption2).foregroundStyle(.tertiary) }
              }
              if let text = doc.text { Text(text.prefix(300)).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
            }
          }
        } label: { Label("Sources indexées (\(knowledge?.kbChunks ?? 0) extraits)", systemImage: "books.vertical") }

        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            Text("Brief (.avity/brief.md) : injecté en tête de chaque session").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $brief).font(.callout).frame(minHeight: 80).scrollContentBackground(.hidden).background(Palette.codeBackground)
            Text("Instructions (AGENTS.md)").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $instructions).font(.callout.monospaced()).frame(minHeight: 120).scrollContentBackground(.hidden).background(Palette.codeBackground)
            HStack {
              Spacer()
              Button("Enregistrer") {
                act("Enregistrement…") { _ = try await $0.updateProject(project, ["brief": .string(brief), "instructions": .string(instructions)]) }
              }
              .disabled(documents == nil || (brief == documents?.brief && instructions == documents?.instructions))
            }
          }
        } label: { Label("Brief et instructions", systemImage: "doc.plaintext") }
      }
      .padding(14)
    }
    .task(id: project) { await load(); await loadDocuments() }
  }

  private func color(_ kind: String) -> Color {
    switch kind {
    case "decision": Palette.accentInk
    case "convention": Palette.violet
    case "pitfall": Palette.amber
    case "todo": Palette.green
    default: .secondary
    }
  }

  private func load() async {
    guard let client = app.client else { return }
    knowledge = try? await client.knowledge(project: project, query: query)
  }

  private func loadDocuments() async {
    guard let client = app.client, let docs = try? await client.projectDocuments(project) else { return }
    documents = docs
    brief = docs.brief
    instructions = docs.instructions
  }

  private func act(_ label: String, _ action: @escaping (APIClient) async throws -> Void) {
    guard let client = app.client else { return }
    busy = label
    Task {
      do { try await action(client) } catch { app.toast(error.localizedDescription, error: true) }
      busy = nil
      await load()
      await loadDocuments()
    }
  }

  private func add() {
    let text = newText.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return }
    act("Ajout…") { try await $0.addMemory(project: project, kind: kind, text: text); newText = "" }
  }

  private func importDocument() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = ["pdf", "docx", "odt", "pptx", "xlsx", "md", "txt"].compactMap { UTType(filenameExtension: $0) }
    guard panel.runModal() == .OK, let url = panel.url, let data = try? Data(contentsOf: url) else { return }
    guard data.count <= 10_000_000 else { app.toast("Document trop volumineux (10 Mo au plus).", error: true); return }
    act("Import de \(url.lastPathComponent)…") {
      let result = try await $0.post("/projects/\(project)/documents/import", ["name": .string(url.lastPathComponent), "base64": .string(data.base64EncodedString())])
      if let failed = result["failed"]?.array, !failed.isEmpty { app.toast("Import partiel : \(failed.compactMap(\.string).joined(separator: ", "))", error: true) }
      else { app.toast("\(url.lastPathComponent) importé et indexé.") }
    }
  }

  private func exportMarkdown() {
    act("Export…") { client in
      let exported: ExportedMarkdown = try await client.get("/projects/\(project)/memory/export")
      let panel = NSSavePanel()
      panel.nameFieldStringValue = exported.filename
      if panel.runModal() == .OK, let url = panel.url { try Data(exported.markdown.utf8).write(to: url) }
    }
  }
}

/// What the next agent connection receives: brief, instructions, git state, recent sessions and chosen knowledge.
struct ContextPane: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  @State private var selection = ContextSelection()
  @State private var pack: ContextPack?
  @State private var loaded = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        GroupBox {
          VStack(alignment: .leading, spacing: 6) {
            Toggle("Brief du projet", isOn: flag(\.includeBrief))
            Toggle("Instructions (AGENTS.md)", isOn: flag(\.includeInstructions))
            Toggle("État git", isOn: flag(\.includeGit))
            Toggle("Résumés des sessions récentes", isOn: flag(\.includeRecent))
            Text("Complément injecté").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: Binding(get: { selection.custom ?? "" }, set: { selection.custom = $0 }))
              .font(.callout).frame(minHeight: 80).scrollContentBackground(.hidden).background(Palette.codeBackground)
            HStack {
              Text("S’applique à la prochaine connexion de l’agent.").font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("Enregistrer") { save() }.disabled(!loaded)
            }
          }
        } label: { Label("Contexte injecté", systemImage: "text.alignleft") }

        GroupBox {
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(pack?.stats ?? "").font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("Actualiser") { Task { await preview() } }.buttonStyle(.borderless)
            }
            ForEach(pack?.warnings ?? [], id: \.self) { Text($0).font(.caption).foregroundStyle(Palette.amber) }
            Text(pack?.text ?? "").font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
          }
        } label: { Label("Aperçu", systemImage: "eye") }
      }
      .padding(14)
    }
    .task(id: thread.id) {
      if let current = try? await app.client?.contextSelection(thread.id) { selection = current; loaded = true }
      await preview()
    }
  }

  private func flag(_ key: WritableKeyPath<ContextSelection, Bool?>) -> Binding<Bool> {
    Binding(get: { selection[keyPath: key] ?? true }, set: { selection[keyPath: key] = $0 })
  }

  private func preview() async {
    pack = try? await app.client?.contextPack(thread.id, query: thread.composer.text)
  }

  private func save() {
    app.run {
      guard let client = app.client else { return }
      selection = try await client.setContextSelection(thread.id, selection)
      app.toast("Contexte enregistré.")
      await preview()
    }
  }
}
