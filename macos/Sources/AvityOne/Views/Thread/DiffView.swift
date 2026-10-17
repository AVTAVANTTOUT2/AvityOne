import SwiftUI
import AvityKit

/// Lines of a diff with old/new numbers. `onComment` adds the « + » of Codex's inline review comments.
struct DiffLinesView: View {
  var lines: [DiffLine]
  var onComment: ((DiffLine) -> Void)? = nil
  @State private var hovered: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(lines) { line in
        HStack(spacing: 0) {
          if line.kind == .fold {
            Text("⋯").foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 76)
          } else {
            Text(line.oldNumber.map(String.init) ?? "").frame(width: 34, alignment: .trailing).foregroundStyle(.tertiary)
            Text(line.newNumber.map(String.init) ?? "").frame(width: 34, alignment: .trailing).foregroundStyle(.tertiary)
            Text(marker(line)).frame(width: 16).foregroundStyle(color(line))
            Text(line.text.isEmpty ? " " : line.text)
              .frame(maxWidth: .infinity, alignment: .leading)
              .lineLimit(1)
              .truncationMode(.tail)
            if let onComment, hovered == line.id, line.newNumber != nil {
              Button { onComment(line) } label: { Image(systemName: "plus.bubble.fill") }
                .buttonStyle(.borderless)
                .foregroundStyle(Palette.accentInk)
                .help("Commenter cette ligne et l’envoyer à l’agent")
                .padding(.trailing, 6)
            }
          }
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.vertical, 1)
        .background(background(line))
        .contentShape(Rectangle())
        .onHover { inside in hovered = inside ? line.id : (hovered == line.id ? nil : hovered) }
      }
    }
    .textSelection(.enabled)
  }

  private func marker(_ line: DiffLine) -> String { line.kind == .added ? "+" : line.kind == .removed ? "−" : "" }
  private func color(_ line: DiffLine) -> Color { line.kind == .added ? Palette.green : line.kind == .removed ? Palette.red : .secondary }
  private func background(_ line: DiffLine) -> Color { line.kind == .added ? Palette.added : line.kind == .removed ? Palette.removed : .clear }
}

/// A tool edit's before/after, folded around the changes.
struct ToolDiffView: View {
  var diff: ToolDiff
  var body: some View {
    let lines = DiffParser.lineDiff(old: diff.old, new: diff.new)
    let added: Int = lines.filter { $0.kind == .added }.count
    let removed: Int = lines.filter { $0.kind == .removed }.count
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Image(systemName: "doc.text").foregroundStyle(.secondary)
        Text(diff.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
        Spacer()
        Text(verbatim: "+\(added) −\(removed)").font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 10).padding(.vertical, 6)
      Divider().opacity(0.5)
      ScrollView(.horizontal) { DiffLinesView(lines: lines).frame(minWidth: 520) }
        .frame(maxHeight: 320)
    }
    .background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
  }
}
