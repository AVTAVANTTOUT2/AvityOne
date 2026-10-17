import SwiftUI
import AvityKit

@main @MainActor
struct AvityOneApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var app = AppModel.shared
  @State private var preferences = Preferences.shared

  init() {
    if CommandLine.arguments.contains("--smoke-test") { exit(SmokeTest.run()) }
  }

  var body: some Scene {
    WindowGroup("AvityOne", id: "main") {
      RootView()
        .environment(app)
        .preferredColorScheme(preferences.appearance.scheme)
        .frame(minWidth: 960, minHeight: 600)
    }
    .defaultSize(width: 1320, height: 860)
    .windowToolbarStyle(.unified(showsTitle: true))
    .commands { AvityCommands(app: app) }

    WindowGroup("Fil", id: "thread", for: String.self) { $sessionId in
      if let sessionId {
        DetachedThreadView(sessionId: sessionId)
          .environment(app)
          .preferredColorScheme(preferences.appearance.scheme)
      }
    }
    .defaultSize(width: 780, height: 840)

    Settings {
      SettingsView()
        .environment(app)
        .preferredColorScheme(preferences.appearance.scheme)
    }

    MenuBarExtra {
      MenuBarView().environment(app)
    } label: {
      MenuBarLabel(app: app)
    }
    .menuBarExtraStyle(.window)
  }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    Notifier.shared.setup()
    Task { await AppModel.shared.boot() }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    let app = AppModel.shared
    guard app.isLocal, app.anyBusy else { return .terminateNow }
    let alert = NSAlert()
    alert.messageText = "Des agents travaillent encore"
    alert.informativeText = "Quitter AvityOne arrête le moteur local et interrompt leurs tours. Les demandes en file reprendront au prochain lancement ; un tour interrompu devra être relancé."
    alert.addButton(withTitle: "Quitter quand même")
    alert.addButton(withTitle: "Annuler")
    return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
  }

  func applicationWillTerminate(_ notification: Notification) {
    EngineController.shared.stop(wait: 2)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

struct AvityCommands: Commands {
  let app: AppModel
  @Environment(\.openWindow) private var openWindow

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("Nouveau fil") { app.startNewThread() }.keyboardShortcut("n")
      Button("Nouveau projet…") { app.showNewProject = true }.keyboardShortcut("n", modifiers: [.command, .shift])
      Divider()
      Button("Ouvrir le fil dans une nouvelle fenêtre") {
        if let id = app.selectedSessionId { openWindow(id: "thread", value: id) }
      }
      .keyboardShortcut("o", modifiers: [.command, .shift])
    }
    CommandMenu("Fil") {
      Button("Palette de commandes…") { app.showPalette = true }.keyboardShortcut("k")
      Divider()
      Button("Arrêter l’agent") { app.selectedThread?.cancel() }.keyboardShortcut(".")
      Button("Fil précédent") { app.moveSelection(-1) }.keyboardShortcut(.upArrow, modifiers: .option)
      Button("Fil suivant") { app.moveSelection(1) }.keyboardShortcut(.downArrow, modifiers: .option)
      Divider()
      Button("Revue croisée") { app.selectedThread?.review() }.keyboardShortcut("r", modifiers: [.command, .shift])
      Button("Résumer et mémoriser") { app.selectedThread?.summarize() }
      Button("Exporter en Markdown…") { app.selectedThread?.exportMarkdown() }
    }
    CommandGroup(after: .sidebar) {
      Button("Afficher ou masquer la revue") { app.showInspector.toggle() }.keyboardShortcut("b", modifiers: [.command, .option])
      Button("Afficher ou masquer le terminal") { app.showTerminal.toggle() }.keyboardShortcut("j")
      Divider()
    }
  }
}
