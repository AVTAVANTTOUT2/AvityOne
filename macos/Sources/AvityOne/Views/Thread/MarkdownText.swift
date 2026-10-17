import SwiftUI
import MarkdownUI

/// Agent output rendered as Markdown. It is untrusted: images are never fetched (a remote image would leak that the
/// message was read), only shown as links.
struct MarkdownText: View {
  var text: String
  var body: some View {
    Markdown(text)
      .markdownTheme(.avity)
      .markdownImageProvider(LinkOnlyImages())
      .markdownInlineImageProvider(NoInlineImages())
      .textSelection(.enabled)
  }
}

struct LinkOnlyImages: ImageProvider {
  @ViewBuilder func makeImage(url: URL?) -> some View {
    if let url {
      Link(destination: url) { Label(url.absoluteString, systemImage: "photo").font(.caption) }
    }
  }
}

struct NoInlineImages: InlineImageProvider {
  func image(with url: URL, label: String) async throws -> Image { throw URLError(.cancelled) }
}

extension Theme {
  static let avity = Theme.gitHub
    .text {
      ForegroundColor(.primary)
      FontSize(14)
    }
    .code {
      FontFamilyVariant(.monospaced)
      FontSize(.em(0.88))
      BackgroundColor(Color.primary.opacity(0.08))
    }
    .link {
      ForegroundColor(Palette.accentInk)
    }
    .codeBlock { configuration in
      CodeBlockView(configuration: configuration)
    }
}

struct CodeBlockView: View {
  var configuration: CodeBlockConfiguration
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(configuration.language?.isEmpty == false ? configuration.language! : "code").font(.caption.monospaced()).foregroundStyle(.secondary)
        Spacer()
        Button {
          copyToPasteboard(configuration.content)
          copied = true
          Task { try? await Task.sleep(nanoseconds: 1_200_000_000); copied = false }
        } label: {
          Label(copied ? "Copié" : "Copier", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption)
        }
        .buttonStyle(.borderless)
      }
      .padding(.horizontal, 12).padding(.vertical, 6)
      Divider().opacity(0.5)
      ScrollView(.horizontal) {
        configuration.label
          .fixedSize(horizontal: false, vertical: true)
          .relativeLineSpacing(.em(0.2))
          .markdownTextStyle {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.86))
          }
          .padding(12)
      }
    }
    .background(Palette.codeBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Palette.line))
    .markdownMargin(top: 4, bottom: 12)
  }
}
