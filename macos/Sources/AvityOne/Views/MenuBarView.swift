import SwiftUI
import AvityKit

/// Menu bar: which agents work or wait, with quick approval, even when every window is closed.
struct MenuBarView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        LogoMark(size: 16)
        Text("AvityOne").font(.headline)
        Spacer()
        Text(app.preferences.activeProfile.name).font(.caption).foregroundStyle(.secondary)
      }
      let live = app.waitingSessions()
      if live.isEmpty {
        Text(app.connection == .ready ? "Aucun agent au travail." : "Moteur non connecté.").font(.callout).foregroundStyle(.secondary)
      }
      ForEach(live) { entry in
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            SignalDot(signal: entry.activity.signal)
            Text(entry.row?.displayTitle ?? "Fil").lineLimit(1)
            Spacer()
            Text(app.projects.first { $0.id == entry.activity.projectId }?.name ?? "").font(.caption).foregroundStyle(.secondary)
          }
          if let permission = app.pendingPermissions[entry.id], let options = permission.options {
            Text(permission.title ?? "Autorisation demandée").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            HStack {
              ForEach(options) { option in
                Button(option.name) { Task { await app.respondPermission(session: entry.id, permId: permission.id, optionId: option.id) } }
                  .controlSize(.small)
              }
            }
          }
        }
        .contentShape(Rectangle())
        .onTapGesture { show(entry.id) }
      }
      Divider()
      HStack {
        Button("Ouvrir AvityOne") { show(nil) }
        Spacer()
        Button("Quitter") { NSApp.terminate(nil) }
      }
      .buttonStyle(.borderless)
    }
    .padding(14)
    .frame(width: 340)
  }

  private func show(_ session: String?) {
    NSApp.activate(ignoringOtherApps: true)
    if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeMain }) { openWindow(id: "main") }
    if let session { app.open(sessionId: session) }
  }
}

struct MenuBarLabel: View {
  var app: AppModel
  var body: some View {
    let waiting = app.activity.values.filter(\.waiting).count
    let busy = app.activity.values.contains(where: \.busy)
    HStack(spacing: 2) {
      Image(systemName: waiting > 0 ? "hand.raised.fill" : busy ? "sparkles" : "diamond")
      if waiting > 0 { Text("\(waiting)") }
    }
  }
}
