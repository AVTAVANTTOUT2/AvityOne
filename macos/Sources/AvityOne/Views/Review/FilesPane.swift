import SwiftUI
import AvityKit

/// Explorer and editor of the thread's workspace (its worktree when isolated). Saves check the file's revision.
struct FilesPane: View {
  @Environment(AppModel.self) private var app
  @Bindable var thread: ThreadModel
  @State private var folder = ""
  @State private var entries: [FileEntry] = []
  @State private var file: FileContent?
  @State private var text = ""
  @State private var error: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        Button { open(folder: parent(of: folder)) } label: { Image(systemName: "chevron.up") }.buttonStyle(.borderless).disabled(folder.isEmpty)
        Text(folder.isEmpty ? "/" : folder).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
        Spacer()
        if app.isLocal, let root = thread.workspacePath {
          Button { OpenIn.reveal(root + (folder.isEmpty ? "" : "/" + folder)) } label: { Image(systemName: "folder") }.buttonStyle(.borderless).help("Afficher dans le Finder")
        }
      }
      .padding(8)
      Divider()
      VSplitView {
        List(entries) { entry in
          Button { entry.directory ? open(folder: entry.path) : open(file: entry.path) } label: {
            Label(entry.name, systemImage: entry.directory ? "folder.fill" : "doc.text")
              .foregroundStyle(file?.path == entry.path ? Palette.accentInk : .primary)
          }
          .buttonStyle(.plain)
        }
        .frame(minHeight: 140)
        VStack(spacing: 0) {
          if let file {
            HStack {
              Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
              Spacer()
              if text != file.text { Tag(text: "modifié", color: Palette.amber) }
              Button("Recharger") { open(file: file.path) }.buttonStyle(.borderless)
              Button("Enregistrer") { save() }.keyboardShortcut("s").disabled(text == file.text)
            }
            .padding(8)
            TextEditor(text: $text)
              .font(.system(size: 12, design: .monospaced))
              .scrollContentBackground(.hidden)
              .background(Palette.codeBackground)
          } else {
            Text("Choisis un fichier").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
          }
        }
        .frame(minHeight: 200)
      }
      if let error { Text(error).font(.caption).foregroundStyle(Palette.red).padding(6) }
    }
    .task(id: thread.id) { open(folder: "") }
    .onChange(of: thread.focusFile) { _, path in
      if let path { open(folder: parent(of: path)); open(file: path); thread.focusFile = nil }
    }
  }

  private func parent(of path: String) -> String {
    let parts = path.split(separator: "/").dropLast()
    return parts.joined(separator: "/")
  }

  private func open(folder path: String) {
    Task {
      do { entries = try await app.client?.files(thread.id, path: path).entries ?? []; folder = path; error = nil }
      catch { self.error = error.localizedDescription }
    }
  }

  private func open(file path: String) {
    Task {
      do {
        guard let loaded = try await app.client?.file(thread.id, path: path) else { return }
        file = loaded; text = loaded.text; error = nil
      } catch { self.error = error.localizedDescription }
    }
  }

  private func save() {
    guard var current = file else { return }
    current.text = text
    Task {
      do {
        guard let saved = try await app.client?.saveFile(thread.id, current) else { return }
        file = saved; text = saved.text; error = nil
        app.toast("\(saved.path) enregistré.")
      } catch { self.error = error.localizedDescription }
    }
  }
}
