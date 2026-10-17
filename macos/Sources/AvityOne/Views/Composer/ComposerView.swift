import SwiftUI
import UniformTypeIdentifiers
import AvityKit

/// The composer: text (Entrée envoie, Maj+Entrée va à la ligne), agent, mode, approvals, worktree, model and effort,
/// attachments (drop, paste, screenshot), dictation (⌃M held) and `/` commands.
struct ComposerView: View {
  @Environment(AppModel.self) private var app
  @Bindable var composer: ComposerState
  var thread: ThreadModel?
  @State private var dictation = Dictation()
  @State private var dictationBase = ""
  @State private var commands: [AgentCommand] = []
  @State private var dropping = false
  @FocusState private var focused: Bool

  private var live: LiveState { thread?.live ?? LiveState() }
  private var busy: Bool { live.busy }

  var body: some View {
    VStack(spacing: 8) {
      if !suggestions.isEmpty { CommandSuggestions(commands: suggestions) { composer.text = "/\($0.name) " } }
      if let error = dictation.error {
        HStack {
          Image(systemName: "mic.slash").foregroundStyle(Palette.amber)
          Text(error).font(.caption)
          Spacer()
          Button("Fermer") { dictation.error = nil }.buttonStyle(.borderless).font(.caption)
        }
        .padding(.horizontal, 14)
      }
      VStack(alignment: .leading, spacing: 8) {
        if !composer.attachments.isEmpty { AttachmentStrip(composer: composer) }
        ZStack(alignment: .topLeading) {
          if composer.text.isEmpty {
            Text(placeholder).foregroundStyle(.tertiary).padding(.top, 1).padding(.leading, 5).allowsHitTesting(false)
          }
          TextEditor(text: $composer.text)
            .font(.system(size: 14))
            .scrollContentBackground(.hidden)
            .frame(minHeight: 44, maxHeight: 220)
            .fixedSize(horizontal: false, vertical: true)
            .focused($focused)
            .onKeyPress(.return, phases: .down) { press in
              if press.modifiers.contains(.shift) || press.modifiers.contains(.option) { return .ignored }
              submit()
              return .handled
            }
            .onKeyPress(.escape) {
              if busy, let thread { thread.cancel(); return .handled }
              return .ignored
            }
            .onKeyPress(KeyEquivalent("m"), phases: [.down, .up]) { press in
              guard press.modifiers.contains(.control) else { return .ignored }
              if press.phase == .down && !dictation.active { startDictation() }
              if press.phase == .up && dictation.active { Task { await dictation.stop() } }
              return .handled
            }
        }
        ComposerControls(composer: composer, thread: thread, dictation: dictation, onDictate: toggleDictation, onSend: submit)
      }
      .padding(12)
      .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(dropping ? Palette.accent : (focused ? Palette.accent.opacity(0.5) : Palette.line), lineWidth: dropping ? 2 : 1))
      .shadow(color: .black.opacity(0.12), radius: 10, y: 2)
      .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { providers in drop(providers); return true }
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 14)
    .padding(.top, 6)
    .frame(maxWidth: 900)
    .frame(maxWidth: .infinity)
    .onAppear { focused = true }
    .onChange(of: app.focusComposer) { _, _ in focused = true }
    .task(id: commandAgent) { await loadCommands() }
    .onDisappear { dictation.cancel() }
  }

  private var placeholder: String {
    if busy { return "L’agent travaille : ton message partira à la fin du tour (Échap arrête)" }
    return thread == nil ? "Décris la tâche… @agent pour choisir, /plan pour planifier d’abord" : "Réponds, précise ou demande la suite…"
  }

  /// `/` commands of the agent that will answer: the connected session's own list, otherwise the agent's catalogue.
  private var commandAgent: String? {
    composer.agent != "auto" ? composer.agent : (live.agent ?? thread?.session?.agent)
  }

  private var suggestions: [AgentCommand] {
    guard composer.text.hasPrefix("/"), !composer.text.contains(" ") else { return [] }
    let query = composer.text.dropFirst().lowercased()
    let builtin = [AgentCommand(name: "plan", description: "Planifier avant d’agir (mode plan)"), AgentCommand(name: "review", description: "Revue en lecture seule")]
    let all = builtin + (live.commands.isEmpty ? commands : live.commands)
    return Array(all.filter { query.isEmpty || $0.name.lowercased().hasPrefix(query) }.prefix(8))
  }

  private func loadCommands() async {
    guard let agent = commandAgent, live.commands.isEmpty, let client = app.client else { commands = []; return }
    commands = (try? await client.commands(agent: agent)) ?? []
  }

  private func submit() {
    guard !composer.sending else { return }
    if dictation.active { dictation.cancel() }
    Task { await app.send(composer, in: thread) }
  }

  private func toggleDictation() {
    if dictation.active { Task { await dictation.stop() } } else { startDictation() }
  }

  private func startDictation() {
    dictationBase = composer.text
    let base = dictationBase
    Task {
      await dictation.start(language: app.preferences.dictationLanguage, server: app.client) { text in
        composer.text = base.isEmpty ? text : base + (base.hasSuffix(" ") ? "" : " ") + text
      }
    }
  }

  private func drop(_ providers: [NSItemProvider]) {
    for provider in providers {
      if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        _ = provider.loadObject(ofClass: URL.self) { [composer, app] url, _ in
          guard let url else { return }
          Task { @MainActor in if let error = composer.attach(url: url) { app.toast(error, error: true) } }
        }
      } else if provider.canLoadObject(ofClass: NSImage.self) {
        _ = provider.loadObject(ofClass: NSImage.self) { [composer, app] image, _ in
          guard let image = image as? NSImage, let png = image.pngData() else { return }
          Task { @MainActor in if let error = composer.attach(image: png, name: "image.png") { app.toast(error, error: true) } }
        }
      }
    }
  }
}

extension NSImage {
  func pngData() -> Data? {
    guard let tiff = tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
    return bitmap.representation(using: .png, properties: [:])
  }
}

struct ComposerControls: View {
  @Environment(AppModel.self) private var app
  @Bindable var composer: ComposerState
  var thread: ThreadModel?
  var dictation: Dictation
  var onDictate: () -> Void
  var onSend: () -> Void

  private var live: LiveState { thread?.live ?? LiveState() }

  var body: some View {
    HStack(spacing: 6) {
      AttachMenu(composer: composer)
      Menu {
        Picker("Agent", selection: $composer.agent) {
          Label("Auto (routage)", systemImage: "sparkles").tag("auto")
          ForEach(app.agents) { agent in
            Text(agent.name + (agent.installed ? "" : " — non installé")).tag(agent.id)
          }
        }
        .pickerStyle(.inline)
      } label: {
        HStack(spacing: 4) {
          Image(systemName: composer.agent == "auto" ? "sparkles" : AgentIdentity.of(composer.agent).symbol)
            .foregroundStyle(composer.agent == "auto" ? Palette.accentInk : AgentIdentity.of(composer.agent).tint)
          Text(verbatim: composer.agent == "auto" ? "Auto" : app.agentName(composer.agent))
        }
      }
      .menuStyle(.borderlessButton).fixedSize()
      .help("Agent qui répond : Auto applique les mentions, les règles et la continuité")

      Picker("Mode", selection: $composer.mode) {
        Text("Auto").tag("")
        Text("Agent").tag("agent")
        Text("Plan").tag("plan")
      }
      .pickerStyle(.segmented)
      .fixedSize()
      .help("Plan : l’agent propose sans modifier ; tu valides avant l’exécution")

      ForEach(live.selectors) { option in
        Menu {
          ForEach(option.choices) { choice in
            Button { thread?.setConfig(option, choice.value) } label: {
              if choice.value == option.currentValue { Label(choice.name, systemImage: "checkmark") } else { Text(choice.name) }
            }
          }
        } label: { Text(option.currentName).lineLimit(1) }
          .menuStyle(.borderlessButton).fixedSize()
          .help(option.name)
      }

      Spacer(minLength: 6)

      if let thread {
        Toggle(isOn: Binding(get: { thread.live.autoApprove }, set: { thread.setAutoApprove($0) })) {
          Image(systemName: thread.live.autoApprove ? "checkmark.shield" : "hand.raised")
        }
        .toggleStyle(.button)
        .help(thread.live.autoApprove ? "Approbation auto (les actions risquées en mode plan restent demandées)" : "Chaque action est soumise à ton accord")
        if !thread.live.isolated && thread.live.worktree == nil && (thread.session?.turns ?? 0) == 0 {
          Toggle(isOn: Binding(get: { thread.live.isolated }, set: { thread.setIsolated($0) })) { Image(systemName: "arrow.triangle.branch") }
            .toggleStyle(.button)
            .help("Worktree : l’agent travaille dans une copie isolée sur sa propre branche")
        } else if thread.live.isolated || thread.live.worktree != nil {
          Image(systemName: "arrow.triangle.branch").foregroundStyle(Palette.violet).help("Ce fil travaille dans un worktree isolé")
        }
      } else {
        Toggle(isOn: $composer.isolated) { Label("Worktree", systemImage: "arrow.triangle.branch") }
          .toggleStyle(.button)
          .help("Local : dans le dossier du projet. Worktree : copie isolée sur sa propre branche.")
      }

      Button(action: onDictate) {
        Image(systemName: dictation.phase == .transcribing ? "waveform" : (dictation.active ? "mic.fill" : "mic"))
          .foregroundStyle(dictation.active ? Palette.red : .secondary)
          .symbolEffect(.pulse, isActive: dictation.active)
      }
      .buttonStyle(.borderless)
      .help("Dictée (maintenir ⌃M)")

      if live.busy, let thread {
        Button { thread.cancel() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 22)) }
          .buttonStyle(.borderless)
          .foregroundStyle(Palette.red)
          .help("Arrêter l’agent (Échap)")
      }
      Button(action: onSend) {
        Image(systemName: live.busy ? "text.badge.plus" : "arrow.up.circle.fill").font(.system(size: 22))
      }
      .buttonStyle(.borderless)
      .foregroundStyle(canSend ? Palette.accent : Color.secondary)
      .disabled(!canSend)
      .help(live.busy ? "Mettre en file" : "Envoyer (Entrée)")
    }
    .font(.callout)
  }

  private var canSend: Bool {
    !composer.sending && (!composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !composer.attachments.isEmpty)
  }
}

struct AttachMenu: View {
  @Environment(AppModel.self) private var app
  @Bindable var composer: ComposerState
  var body: some View {
    Menu {
      Button("Fichiers…") { pickFiles() }
      Button("Image du presse-papiers") { pasteImage() }
      Button("Capture d’écran…") {
        Task {
          if let url = await ScreenCapture.interactive(), let error = composer.attach(url: url) { app.toast(error, error: true) }
        }
      }
    } label: { Image(systemName: "plus") }
      .menuStyle(.borderlessButton)
      .fixedSize()
      .help("Joindre des fichiers, une image ou une capture (8 × 5 Mio)")
  }

  private func pickFiles() {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    if panel.runModal() == .OK {
      for url in panel.urls { if let error = composer.attach(url: url) { app.toast(error, error: true) } }
    }
  }

  private func pasteImage() {
    let board = NSPasteboard.general
    if let image = NSImage(pasteboard: board), let png = image.pngData() {
      if let error = composer.attach(image: png, name: "presse-papiers.png") { app.toast(error, error: true) }
    } else if let urls = board.readObjects(forClasses: [NSURL.self]) as? [URL], !urls.isEmpty {
      for url in urls { if let error = composer.attach(url: url) { app.toast(error, error: true) } }
    } else {
      app.toast("Aucune image dans le presse-papiers.", error: true)
    }
  }
}

struct AttachmentStrip: View {
  @Bindable var composer: ComposerState
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(composer.attachments) { attachment in
          HStack(spacing: 6) {
            if attachment.mime.hasPrefix("image/"), let image = NSImage(data: attachment.data) {
              Image(nsImage: image).resizable().scaledToFill().frame(width: 26, height: 26).clipShape(RoundedRectangle(cornerRadius: 5))
            } else {
              Image(systemName: "doc").foregroundStyle(.secondary)
            }
            Text(attachment.name).lineLimit(1).font(.caption)
            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file)).font(.caption2).foregroundStyle(.tertiary)
            Button { composer.attachments.removeAll { $0.id == attachment.id } } label: { Image(systemName: "xmark.circle.fill") }
              .buttonStyle(.borderless).foregroundStyle(.secondary)
          }
          .padding(.horizontal, 8).padding(.vertical, 4)
          .background(Palette.raised, in: Capsule())
        }
      }
    }
  }
}

struct CommandSuggestions: View {
  var commands: [AgentCommand]
  var choose: (AgentCommand) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(commands) { command in
        Button { choose(command) } label: {
          HStack {
            Text("/\(command.name)").font(.callout.monospaced().weight(.medium))
            Text(command.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if let hint = command.hint { Text(hint).font(.caption2).foregroundStyle(.tertiary) }
          }
          .padding(.horizontal, 12).padding(.vertical, 6)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 4)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line))
    .padding(.horizontal, 20)
  }
}
