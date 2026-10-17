import AVFoundation
import AppKit
import SwiftUI
import AvityKit

struct FeedRow: View {
  @Environment(AppModel.self) private var app
  var item: Item
  @Bindable var thread: ThreadModel
  var latest: Bool
  var turn: Feed.Turn?
  var retry: Bool

  var body: some View {
    switch item.itemType {
    case .user: UserMessageRow(item: item, thread: thread)
    case .assistant:
      VStack(alignment: .leading, spacing: 8) {
        if let text = item.text, !text.isEmpty { MarkdownText(text: text) }
        if let content = item.content { MediaBlocks(blocks: content) }
      }
      .padding(.leading, 34)
    case .thought: ThoughtRow(text: item.text ?? "", live: latest && thread.live.busy)
    case .tool: ToolCallRow(item: item, turnOver: !latest || !thread.live.busy)
    case .plan: PlanRow(entries: item.entries ?? [])
    case .permission: PermissionCard(item: item, thread: thread)
    case .end: TurnFooter(item: item, thread: thread, turn: turn, latest: latest)
    case .error:
      Card(tint: Palette.red) {
        HStack(alignment: .top) {
          Image(systemName: "xmark.octagon.fill").foregroundStyle(Palette.red)
          Text(item.text ?? "Erreur").textSelection(.enabled)
          Spacer()
          if retry { Button("Réessayer") { thread.retry() }.disabled(thread.live.busy) }
        }
      }
      .padding(.leading, 34)
    case .info:
      if item.level == "warn" {
        Card(tint: Palette.amber) {
          Label { Text(item.text ?? "").textSelection(.enabled) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.amber) }
        }
        .padding(.leading, 34)
      } else {
        Label { Text(item.text ?? "").textSelection(.enabled) } icon: { Image(systemName: "info.circle") }
          .font(.callout)
          .foregroundStyle(.secondary)
          .padding(.leading, 34)
      }
    case .review: ReviewRow(item: item)
    case .parallel: ParallelRow(item: item)
    case .unknown: EmptyView()
    }
  }
}

struct UserMessageRow: View {
  @Environment(AppModel.self) private var app
  var item: Item
  @Bindable var thread: ThreadModel
  @State private var editing = false
  @State private var draft = ""

  var body: some View {
    VStack(alignment: .trailing, spacing: 6) {
      if editing {
        VStack(alignment: .trailing, spacing: 8) {
          TextEditor(text: $draft)
            .font(.body)
            .frame(minHeight: 70, maxHeight: 220)
            .scrollContentBackground(.hidden)
            .padding(8)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
          HStack {
            Button("Annuler") { editing = false }
            Button("Dans un nouveau fil") { thread.edit(item, text: draft, fork: true); editing = false }
            Button("Renvoyer") { thread.edit(item, text: draft, fork: false); editing = false }.buttonStyle(.borderedProminent)
          }
          Text("Renvoyer coupe la conversation à ce message.").font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: 620)
      } else {
        Text(item.text ?? "")
          .textSelection(.enabled)
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(Palette.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .frame(maxWidth: 620, alignment: .trailing)
        if let attachments = item.attachments, !attachments.isEmpty {
          HStack { ForEach(attachments) { a in Tag(text: a.name, symbol: a.mime.hasPrefix("image/") ? "photo" : "paperclip") } }
        }
        HStack(spacing: 6) {
          if let agent = item.agent { Text(verbatim: "→ " + app.agentName(agent)) }
          if let reason = item.reason { Text("· \(reason)") }
          if item.mode == "plan" { Tag(text: "plan", color: Palette.violet) }
          if item.edited == true { Text("· modifié") }
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .contextMenu {
      Button("Copier") { copyToPasteboard(item.text ?? "") }
      Button("Modifier et renvoyer…") { draft = item.text ?? ""; editing = true }.disabled(thread.live.busy)
      Button("Bifurquer avant ce message") { thread.fork(before: item.id) }
    }
  }
}

struct ThoughtRow: View {
  var text: String
  var live: Bool
  @State private var open = false
  var body: some View {
    DisclosureGroup(isExpanded: $open) {
      Text(text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "brain").foregroundStyle(Palette.violet)
        Text(live ? "Réfléchit…" : "Réflexion").foregroundStyle(.secondary)
        if !open { Text(text.split(separator: "\n").last.map(String.init) ?? "").lineLimit(1).foregroundStyle(.tertiary) }
      }
      .font(.callout)
    }
    .padding(.leading, 34)
  }
}

struct ToolCallRow: View {
  var item: Item
  var turnOver: Bool
  @State private var open = false

  var body: some View {
    let interrupted = item.isOpenTool && turnOver
    VStack(alignment: .leading, spacing: 8) {
      Button { withAnimation(.snappy) { open.toggle() } } label: {
        HStack(spacing: 8) {
          Image(systemName: symbol).frame(width: 16).foregroundStyle(.secondary)
          Text(item.title ?? "Outil").lineLimit(1)
          if let path = item.paths?.first { Text(path).font(.caption.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head) }
          Spacer()
          if let diffs = item.diffs, !diffs.isEmpty { Tag(text: "\(diffs.count) fichier\(diffs.count > 1 ? "s" : "")", color: Palette.accentInk) }
          status(interrupted: interrupted)
          Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(open ? 90 : 0)).foregroundStyle(.tertiary)
        }
        .font(.callout)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if open {
        if let command = item.command {
          Text("$ \(command)").font(.caption.monospaced()).textSelection(.enabled).padding(8).frame(maxWidth: .infinity, alignment: .leading).background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 6))
        }
        if let paths = item.paths, paths.count > 1 {
          HStack { ForEach(paths, id: \.self) { Tag(text: $0) } }
        }
        ForEach(item.diffs ?? [], id: \.path) { ToolDiffView(diff: $0) }
        if let output = item.output, !output.isEmpty {
          ScrollView { Text(output).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            .frame(maxHeight: 220)
            .padding(8)
            .background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 6))
        }
      }
    }
    .padding(.horizontal, 10).padding(.vertical, 7)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Palette.line))
    .padding(.leading, 34)
  }

  private var symbol: String {
    switch item.kind {
    case "read": "doc.text.magnifyingglass"
    case "edit": "pencil"
    case "delete": "trash"
    case "move": "arrow.right.doc.on.clipboard"
    case "search": "magnifyingglass"
    case "execute": "terminal"
    case "think": "brain"
    case "fetch": "globe"
    case "switch_mode": "arrow.triangle.swap"
    default: "wrench.and.screwdriver"
    }
  }

  @ViewBuilder private func status(interrupted: Bool) -> some View {
    if interrupted { Tag(text: "interrompu", color: Palette.amber) }
    else {
      switch item.status {
      case "pending", "in_progress": ProgressView().controlSize(.mini)
      case "failed": Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.red)
      default: Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.green.opacity(0.8))
      }
    }
  }
}

struct PlanRow: View {
  var entries: [PlanEntry]
  var body: some View {
    let done = entries.filter { $0.status == "completed" }.count
    Card {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Label("Plan", systemImage: "list.bullet.clipboard").font(.callout.weight(.semibold))
          Spacer()
          Text("\(done)/\(entries.count)").font(.caption.monospaced()).foregroundStyle(.secondary)
        }
        ProgressView(value: Double(done), total: Double(max(entries.count, 1))).tint(Palette.green)
        ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
          HStack(alignment: .top, spacing: 8) {
            Image(systemName: entry.status == "completed" ? "checkmark.circle.fill" : entry.status == "in_progress" ? "circle.dotted.circle" : "circle")
              .foregroundStyle(entry.status == "completed" ? Palette.green : entry.status == "in_progress" ? Palette.accentInk : .secondary)
            Text(entry.content).strikethrough(entry.status == "completed", color: .secondary).foregroundStyle(entry.status == "completed" ? .secondary : .primary)
            if entry.priority == "high" { Tag(text: "prioritaire", color: Palette.amber) }
          }
          .font(.callout)
        }
      }
    }
    .padding(.leading, 34)
  }
}

struct PermissionCard: View {
  @Environment(AppModel.self) private var app
  var item: Item
  @Bindable var thread: ThreadModel
  @State private var answering = false

  var body: some View {
    let planGate = item.kind == "switch_mode"
    Card(tint: item.resolved == nil ? (planGate ? Palette.accent : Palette.amber) : nil) {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Image(systemName: planGate ? "checklist.checked" : "hand.raised.fill").foregroundStyle(planGate ? Palette.accentInk : Palette.amber)
          Text(planGate ? "Plan prêt — on l’exécute ?" : "Autorisation demandée").font(.callout.weight(.semibold))
          Text(item.title ?? "").font(.callout).foregroundStyle(.secondary).lineLimit(1)
        }
        if let text = item.text, !text.isEmpty { MarkdownText(text: text).frame(maxHeight: 360) }
        if let resolved = item.resolved {
          Text("→ \(resolved)").font(.callout).foregroundStyle(.secondary)
        } else {
          HStack {
            ForEach(item.options ?? []) { option in
              if option.isAllow {
                Button(option.name) { answer(option) }.buttonStyle(.borderedProminent).disabled(answering)
              } else {
                Button(option.name) { answer(option) }.disabled(answering)
              }
            }
            Spacer()
            if !thread.live.autoApprove {
              Button("Activer l’approbation auto") { thread.setAutoApprove(true) }.buttonStyle(.link).font(.caption)
            }
          }
        }
      }
    }
    .padding(.leading, 34)
  }

  private func answer(_ option: PermissionOption) {
    answering = true
    Task {
      await thread.respond(item, option: option)
      answering = false
    }
  }
}

struct TurnFooter: View {
  @Environment(AppModel.self) private var app
  var item: Item
  @Bindable var thread: ThreadModel
  var turn: Feed.Turn?
  var latest: Bool

  var body: some View {
    HStack(spacing: 12) {
      if let reason = item.stopReason, reason != "end_turn" {
        Tag(text: reason == "cancelled" ? "arrêté" : reason, color: Palette.amber)
      }
      if let copy = turn?.copy, !copy.isEmpty {
        Button { copyToPasteboard(copy) } label: { Label("Copier", systemImage: "doc.on.doc") }
      }
      if latest && !thread.live.busy {
        Menu {
          Button("Même agent") { thread.regenerate(agent: nil) }
          Divider()
          ForEach(app.installedAgents) { agent in Button(agent.name) { thread.regenerate(agent: agent.id) } }
        } label: { Label("Régénérer", systemImage: "arrow.clockwise") }
          .menuStyle(.borderlessButton)
          .fixedSize()
      }
      Button { thread.fork(before: turn?.before) } label: { Label("Bifurquer ici", systemImage: "arrow.triangle.branch") }
        .disabled(thread.live.busy)
    }
    .buttonStyle(.borderless)
    .labelStyle(.titleAndIcon)
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.leading, 34)
  }
}

struct ReviewRow: View {
  @Environment(AppModel.self) private var app
  var item: Item
  private var reviewer: String? { item.agent.map { app.agentName($0) } }
  var body: some View {
    Card(tint: item.status == "done" ? (item.approved == true ? Palette.green : Palette.red) : nil) {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Image(systemName: "checkmark.seal").foregroundStyle(Palette.accentInk)
          Text(reviewer.map { "Revue croisée par \($0)" } ?? "Revue croisée").font(.callout.weight(.semibold))
          Spacer()
          switch item.status {
          case "running": ProgressView().controlSize(.small)
          case "error": Tag(text: "échec", color: Palette.red)
          default: Tag(text: item.approved == true ? "approuvée" : "corrections demandées", color: item.approved == true ? Palette.green : Palette.red)
          }
        }
        if let text = item.text, !text.isEmpty { MarkdownText(text: text) }
      }
    }
    .padding(.leading, 34)
  }
}

struct ParallelRow: View {
  @Environment(AppModel.self) private var app
  var item: Item
  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 8) {
        Label("Exécution parallèle", systemImage: "square.split.2x2").font(.callout.weight(.semibold))
        ForEach(item.children ?? []) { child in
          HStack(spacing: 8) {
            AgentAvatar(agent: child.agent, size: 18, working: child.status == "running")
            Text(child.task).lineLimit(1)
            if let conflicts = child.conflicts, !conflicts.isEmpty { Tag(text: "conflit : \(conflicts.joined(separator: ", "))", color: Palette.red) }
            Spacer()
            Tag(text: Self.label(child.status), color: Self.color(child.status))
            Button("Ouvrir") { app.select(session: child.id) }.buttonStyle(.link)
          }
          .font(.callout)
        }
      }
    }
    .padding(.leading, 34)
  }

  static func label(_ status: String) -> String {
    ["queued": "en file", "running": "en cours", "waiting": "attend", "done": "terminé", "error": "échec", "cancelled": "annulé",
     "blocked": "bloqué", "merged": "fusionné", "conflict": "conflit", "interrupted": "interrompu"][status] ?? status
  }
  static func color(_ status: String) -> Color {
    switch status {
    case "done", "merged": Palette.green
    case "error", "conflict": Palette.red
    case "running": Palette.accentInk
    case "waiting", "blocked", "interrupted": Palette.amber
    default: .secondary
    }
  }
}

/// ACP image, audio and resource blocks of an answer.
struct MediaBlocks: View {
  var blocks: [ContentBlock]
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block.type {
        case "image":
          if let data = block.data.flatMap({ Data(base64Encoded: $0) }), let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 520, maxHeight: 420).clipShape(RoundedRectangle(cornerRadius: 10))
          }
        case "audio":
          if let data = block.data.flatMap({ Data(base64Encoded: $0) }) { AudioBlock(data: data) }
        case "resource":
          if let text = block.resource?.text {
            VStack(alignment: .leading) {
              Text(block.resource?.uri ?? "ressource").font(.caption.monospaced()).foregroundStyle(.secondary)
              Text(text.prefix(4000)).font(.caption.monospaced()).textSelection(.enabled)
            }
            .padding(8).background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))
          } else { Tag(text: block.resource?.uri ?? "ressource", symbol: "doc") }
        case "resource_link":
          if let uri = block.uri, let url = URL(string: uri) { Link(block.name ?? uri, destination: url) }
        default:
          EmptyView()
        }
      }
    }
  }
}

struct AudioBlock: View {
  var data: Data
  @State private var player: AVAudioPlayer?
  @State private var playing = false
  var body: some View {
    Button {
      if playing { player?.stop(); playing = false; return }
      player = try? AVAudioPlayer(data: data)
      playing = player?.play() ?? false
    } label: { Label(playing ? "Arrêter" : "Écouter", systemImage: playing ? "stop.fill" : "play.fill") }
  }
}
