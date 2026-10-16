import SwiftUI
import AvityKit

/// Validation (tests, lint, build), review findings and the controlled merge of worktree branches.
struct MergePane: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  @State private var validations: [Validation] = []
  @State private var findings: [Finding] = []
  @State private var preview: MergePreview?
  @State private var selectedBranches: Set<String> = []
  @State private var selectedFiles: Set<String> = []
  @State private var working: String?
  @State private var resolutions: [Int: String] = [:]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Button("Lancer tests, lint et build") { act("Validation…") { _ = try await client().post("/sessions/\(thread.id)/validate") } }
              Button("Revue croisée") { thread.review() }
              Spacer()
              if let working { ProgressView().controlSize(.small); Text(working).font(.caption).foregroundStyle(.secondary) }
            }
            if validations.isEmpty { Text("Aucune validation lancée.").font(.callout).foregroundStyle(.secondary) }
            ForEach(validations.prefix(12)) { validation in ValidationRow(validation: validation) }
          }
        } label: { Label("Validations", systemImage: "checkmark.diamond") }

        if !findings.isEmpty {
          GroupBox {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(findings) { finding in
                VStack(alignment: .leading, spacing: 6) {
                  HStack {
                    Text(finding.path).font(.callout.monospaced())
                    Spacer()
                    Tag(text: finding.status == "open" ? "ouverte" : "corrigée", color: finding.status == "open" ? Palette.amber : Palette.green)
                  }
                  Text(finding.message).font(.callout)
                  if finding.status == "open" {
                    HStack {
                      TextField("Correction apportée", text: Binding(get: { resolutions[finding.id] ?? "" }, set: { resolutions[finding.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                      Button("Marquer corrigée") {
                        act("Mise à jour…") {
                          _ = try await client().request(JSONValue.self, "PATCH", "/sessions/\(thread.id)/findings/\(finding.id)", body: ["status": "resolved", "resolution": .string(resolutions[finding.id] ?? "")])
                        }
                      }
                      .disabled((resolutions[finding.id] ?? "").isEmpty)
                    }
                  } else if !finding.resolution.isEmpty {
                    Text("→ \(finding.resolution)").font(.caption).foregroundStyle(.secondary)
                  }
                }
                Divider()
              }
            }
          } label: { Label("Remarques de revue", systemImage: "text.bubble") }
        }

        GroupBox {
          VStack(alignment: .leading, spacing: 8) {
            if let preview, !preview.branches.isEmpty {
              Text("La fusion prépare le résultat dans un worktree temporaire, le valide et le fait relire avant de l’intégrer. Un conflit conserve toutes les branches.")
                .font(.caption).foregroundStyle(.secondary)
              ForEach(preview.branches) { branch in
                VStack(alignment: .leading, spacing: 4) {
                  Toggle(isOn: Binding(get: { selectedBranches.contains(branch.id) }, set: { on in if on { selectedBranches.insert(branch.id) } else { selectedBranches.remove(branch.id) } })) {
                    HStack {
                      Text(branch.branch).font(.callout.monospaced())
                      Text(app.sessions.values.flatMap { $0 }.first { $0.id == branch.id }?.displayTitle ?? "").font(.caption).foregroundStyle(.secondary)
                    }
                  }
                  ForEach(branch.files, id: \.self) { file in
                    Toggle(file, isOn: Binding(get: { selectedFiles.contains(file) }, set: { on in if on { selectedFiles.insert(file) } else { selectedFiles.remove(file) } }))
                      .font(.caption.monospaced())
                      .padding(.leading, 22)
                      .disabled(!selectedBranches.contains(branch.id))
                  }
                }
              }
              HStack {
                Button("Fusionner la sélection") { merge() }
                  .buttonStyle(.borderedProminent)
                  .disabled(selectedBranches.isEmpty || working != nil)
                Button("Résolution assistée des conflits") { act("Envoi à l’agent…") { _ = try await client().post("/sessions/\(thread.id)/conflicts") } }
                  .disabled(!(thread.live.worktree != nil))
                Spacer()
                Text(selectedFiles.isEmpty ? "Branches entières" : "\(selectedFiles.count) fichier(s)").font(.caption).foregroundStyle(.secondary)
              }
            } else {
              Text("Aucun worktree à fusionner : active Worktree sur un fil, ou parallélise un plan.").font(.callout).foregroundStyle(.secondary)
            }
          }
        } label: { Label("Fusion contrôlée", systemImage: "arrow.triangle.merge") }
      }
      .padding(14)
    }
    .task(id: "\(thread.id)-\(thread.validationRevision)") { await load() }
    .onChange(of: thread.live.busy) { _, busy in if !busy { Task { await load() } } }
  }

  private func client() throws -> APIClient {
    guard let client = app.client else { throw APIError(status: 0, message: "Non connecté") }
    return client
  }

  private func load() async {
    guard let client = app.client else { return }
    validations = (try? await client.validations(thread.id)) ?? []
    findings = (try? await client.findings(thread.id)) ?? []
    do {
      let next = try await client.mergePreview(thread.id)
      if preview?.fingerprint != next.fingerprint { selectedBranches = Set(next.branches.map(\.id)); selectedFiles = [] }
      preview = next
    } catch { preview = nil }
  }

  private func act(_ label: String, _ action: @escaping () async throws -> Void) {
    working = label
    Task {
      do { try await action() } catch { app.toast(error.localizedDescription, error: true) }
      working = nil
      await load()
    }
  }

  private func merge() {
    guard let preview else { return }
    var body: [String: JSONValue] = ["branches": .strings(Array(selectedBranches)), "fingerprint": .string(preview.fingerprint)]
    if !selectedFiles.isEmpty { body["files"] = .strings(Array(selectedFiles)) }
    act("Fusion : validation et revue…") {
      let result = try await client().request(MergeResult.self, "POST", "/sessions/\(thread.id)/merge", body: .object(body))
      if let conflicts = result.conflicts, !conflicts.isEmpty { app.toast("Conflit sur \(conflicts.joined(separator: ", ")) : branches conservées.", error: true) }
      else { app.toast("\(result.merged) branche(s) fusionnée(s).") }
      await thread.refreshGit()
    }
  }
}

struct ValidationRow: View {
  var validation: Validation
  @State private var open = false
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button { open.toggle() } label: {
        HStack {
          Image(systemName: validation.status == "passed" ? "checkmark.circle.fill" : validation.status == "running" ? "clock" : "xmark.circle.fill")
            .foregroundStyle(validation.status == "passed" ? Palette.green : validation.status == "running" ? Palette.accentInk : Palette.red)
          Text(validation.command).font(.callout.monospaced()).lineLimit(1)
          Spacer()
          Text(relativeTime(validation.createdAt ?? "")).font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if open, let output = validation.output, !output.isEmpty {
        ScrollView { Text(output).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
          .frame(maxHeight: 200).padding(6).background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 6))
      }
    }
  }
}
