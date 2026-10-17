import SwiftUI
import AvityKit

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
  }
}

/// Tokens of web/src/theme.css, adapted to the system appearance where the web theme is dark-only.
enum Palette {
  static let accent = Color(hex: 0x0071FC)
  static let accentInk = Color(hex: 0x7DB4FF)
  static let green = Color(hex: 0x3ECF8E)
  static let red = Color(hex: 0xFF6B6B)
  static let amber = Color(hex: 0xF5B14C)
  static let violet = Color(hex: 0xB9A7FF)
  static let line = Color.primary.opacity(0.08)
  static let card = Color.primary.opacity(0.04)
  static let raised = Color.primary.opacity(0.07)
  static let codeBackground = Color.primary.opacity(0.05)
  static let added = Color(hex: 0x3ECF8E, opacity: 0.16)
  static let removed = Color(hex: 0xFF6B6B, opacity: 0.16)
}

/// Agent identities of web/src/brand.tsx: one tint and one symbol per agent.
struct AgentIdentity {
  var tint: Color
  var symbol: String

  static func of(_ id: String?) -> AgentIdentity {
    switch id {
    case "claude": return AgentIdentity(tint: Color(hex: 0xF4A46A), symbol: "cat.fill")
    case "codex": return AgentIdentity(tint: Color(hex: 0x4FD1C5), symbol: "drop.fill")
    case "cursor": return AgentIdentity(tint: Color(hex: 0x7DB4FF), symbol: "cube.fill")
    case "opencode": return AgentIdentity(tint: Color(hex: 0xB9A7FF), symbol: "binoculars.fill")
    case nil, "avity": return AgentIdentity(tint: Color(hex: 0xD4D7DE), symbol: "sparkles")
    default:
      let tints: [UInt32] = [0x8EC5FF, 0x7EE08A, 0xFFD166, 0xC5F05A, 0xFF8A6B, 0x8F8CFF]
      let index = Int(id!.unicodeScalars.reduce(UInt(0)) { $0 &* 31 &+ UInt($1.value) } % UInt(tints.count))
      return AgentIdentity(tint: Color(hex: tints[index]), symbol: "cpu")
    }
  }
}

struct AgentAvatar: View {
  var agent: String?
  var size: CGFloat = 22
  var working = false
  @State private var pulse = false

  var body: some View {
    let identity = AgentIdentity.of(agent)
    ZStack {
      Circle().fill(identity.tint.opacity(0.18))
      Image(systemName: identity.symbol)
        .font(.system(size: size * 0.5, weight: .semibold))
        .foregroundStyle(identity.tint)
    }
    .frame(width: size, height: size)
    .overlay(Circle().stroke(identity.tint.opacity(working ? 0.9 : 0.25), lineWidth: working ? 1.5 : 1).scaleEffect(pulse ? 1.18 : 1).opacity(pulse ? 0 : 1))
    .onAppear { if working { withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { pulse = true } } }
    .onChange(of: working) { _, now in
      pulse = false
      if now { withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { pulse = true } }
    }
    .accessibilityHidden(true)
  }
}

struct SignalDot: View {
  var signal: SessionActivity.Signal?
  var body: some View {
    Group {
      switch signal {
      case .waiting: Circle().fill(Palette.amber)
      case .busy: ProgressView().controlSize(.mini)
      case .error: Circle().fill(Palette.red)
      case .done: Circle().fill(Palette.accent)
      case nil: Color.clear
      }
    }
    .frame(width: 8, height: 8)
    .help(signal?.label ?? "")
  }
}

/// A small rounded label: statuses, counts, branches.
struct Tag: View {
  var text: String
  var color: Color = .secondary
  var symbol: String? = nil
  var body: some View {
    HStack(spacing: 3) {
      if let symbol { Image(systemName: symbol) }
      Text(text).lineLimit(1)
    }
    .font(.caption2.weight(.medium))
    .padding(.horizontal, 6).padding(.vertical, 2)
    .background(color.opacity(0.14), in: Capsule())
    .foregroundStyle(color)
  }
}

/// A card surface used by feed rows and panels.
struct Card<Content: View>: View {
  var tint: Color? = nil
  @ViewBuilder var content: Content
  var body: some View {
    content
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background((tint ?? Color.primary).opacity(tint == nil ? 0.04 : 0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke((tint ?? Color.primary).opacity(tint == nil ? 0.08 : 0.35)))
  }
}

/// The logo mark of web/src/brand.tsx: two nested diamonds.
struct LogoMark: View {
  var size: CGFloat = 22
  var body: some View {
    ZStack {
      Diamond().fill(LinearGradient(colors: [Color(hex: 0x9CC5FF), Color(hex: 0x0071FC)], startPoint: .topLeading, endPoint: .bottomTrailing))
      Diamond().fill(LinearGradient(colors: [Color(hex: 0xD9CCFF), Color(hex: 0x6D5DFC)], startPoint: .topTrailing, endPoint: .bottomLeading))
        .frame(width: size * 0.36, height: size * 0.36)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  struct Diamond: Shape {
    func path(in rect: CGRect) -> Path {
      Path { p in
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        p.closeSubpath()
      }
    }
  }
}

func relativeTime(_ text: String) -> String {
  guard let date = parseServerDate(text) else { return "" }
  let seconds = Date().timeIntervalSince(date)
  if seconds < 60 { return "maintenant" }
  if seconds < 3600 { return "\(Int(seconds / 60)) min" }
  if seconds < 86_400 { return "\(Int(seconds / 3600)) h" }
  return "\(Int(seconds / 86_400)) j"
}

func copyToPasteboard(_ text: String) {
  NSPasteboard.general.clearContents()
  NSPasteboard.general.setString(text, forType: .string)
}
