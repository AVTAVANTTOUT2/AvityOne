import SwiftUI
import AvityKit

/// A project is a folder: an existing one, a git clone, or a new empty folder for non-code work.
struct NewProjectSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  enum Source: String, CaseIterable, Identifiable {
    case folder, clone, empty
    var id: String { rawValue }
    var label: String { switch self { case .folder: "Dossier existant"; case .clone: "Cloner un dépôt"; case .empty: "Dossier vide" } }
  }
  @State private var source = Source.folder
  @State private var name = ""
  @State private var path = ""
  @State private var gitURL = ""
  @State private var working = false
  @State private var browsing = false
  @State private var autoName = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Nouveau projet").font(.title2.weight(.semibold))
      Picker("", selection: $source) { ForEach(Source.allCases) { Text($0.label).tag($0) } }
        .pickerStyle(.segmented)
        .labelsHidden()
      Form {
        switch source {
        case .folder:
          LabeledContent("Dossier") {
            HStack {
              Text(path.isEmpty ? "Aucun dossier choisi" : path).lineLimit(1).truncationMode(.middle).foregroundStyle(path.isEmpty ? .secondary : .primary)
              Spacer()
              Button("Choisir…") { choose() }
            }
          }
        case .clone:
          TextField("URL git", text: $gitURL, prompt: Text("https://github.com/organisation/depot.git"))
            .onChange(of: gitURL) { _, url in
              // Follow the URL until the name is edited by hand.
              if name.isEmpty || name == autoName { name = projectName(from: Self.repositoryName(of: url)); autoName = name }
            }
        case .empty:
          EmptyView()
        }
        TextField("Nom", text: $name, prompt: Text("mon-projet"))
        if source != .folder { Text("Créé dans le dossier des projets du moteur.").font(.caption).foregroundStyle(.secondary) }
      }
      .formStyle(.grouped)
      HStack {
        if working { ProgressView().controlSize(.small); Text(source == .clone ? "Clonage…" : "Indexation…").foregroundStyle(.secondary) }
        Spacer()
        Button("Annuler") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Créer") { create() }
          .keyboardShortcut(.defaultAction)
          .disabled(working || name.isEmpty || (source == .folder && path.isEmpty) || (source == .clone && gitURL.isEmpty))
      }
    }
    .padding(22)
    .frame(width: 560)
    .sheet(isPresented: $browsing) {
      FolderBrowser { chosen in
        path = chosen
        if name.isEmpty { name = projectName(from: URL(fileURLWithPath: chosen).lastPathComponent) }
      }
    }
  }

  static func repositoryName(of url: String) -> String {
    let last = url.split(separator: "/").last.map(String.init) ?? ""
    return last.hasSuffix(".git") ? String(last.dropLast(4)) : last
  }

  private func choose() {
    guard app.isLocal else { browsing = true; return }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "Choisir"
    panel.message = "Dossier du projet : les agents y travailleront."
    if panel.runModal() == .OK, let url = panel.url {
      path = url.path
      if name.isEmpty { name = projectName(from: url.lastPathComponent) }
    }
  }

  private func create() {
    working = true
    Task {
      let ok = await app.createProject(name: name, path: source == .folder ? path : nil, git: source == .clone ? gitURL : nil)
      working = false
      if ok { dismiss() }
    }
  }
}

/// Folder picker on the server's disk (remote profiles): `/api/folders`.
struct FolderBrowser: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  var onChoose: (String) -> Void
  @State private var list: FolderList?
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Dossier sur le serveur").font(.headline)
      if let list {
        HStack {
          Button { load(list.parent) } label: { Image(systemName: "chevron.up") }.disabled(list.parent == list.path)
          Text(list.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
        }
        List(list.folders) { folder in
          Button { load(folder.path) } label: { Label(folder.name, systemImage: "folder") }.buttonStyle(.plain)
        }
        .frame(minHeight: 260)
      } else if let error {
        Text(error).foregroundStyle(Palette.red)
      } else { ProgressView() }
      HStack {
        Spacer()
        Button("Annuler") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Choisir ce dossier") { if let list { onChoose(list.path); dismiss() } }.keyboardShortcut(.defaultAction).disabled(list == nil)
      }
    }
    .padding(18)
    .frame(width: 520, height: 420)
    .task { load(nil) }
  }

  private func load(_ path: String?) {
    Task {
      do { list = try await app.client?.folders(path); error = nil } catch { self.error = error.localizedDescription }
    }
  }
}
