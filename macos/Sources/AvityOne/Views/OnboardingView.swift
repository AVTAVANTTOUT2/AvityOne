import SwiftUI
import AvityKit

/// First launch on this Mac: permissions, developer tools, agent CLIs (install + login), first project.
struct OnboardingView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  enum Step: Int, CaseIterable { case welcome, permissions, agents, project }
  @State private var step = Step.welcome
  @State private var permissions = SystemPermissions.shared

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        ForEach(Step.allCases, id: \.rawValue) { s in
          Capsule().fill(s.rawValue <= step.rawValue ? Palette.accent : Palette.line).frame(height: 4)
        }
      }
      .padding(.horizontal, 28).padding(.top, 22)
      Group {
        switch step {
        case .welcome: welcome
        case .permissions: permissionsStep
        case .agents: AgentsSettings()
        case .project: projectStep
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      Divider()
      HStack {
        if step != .welcome { Button("Retour") { step = Step(rawValue: step.rawValue - 1) ?? .welcome } }
        Spacer()
        Button("Passer") { finish() }.buttonStyle(.link)
        Button(step == .project ? "Terminer" : "Continuer") {
          if step == .project { finish() } else { step = Step(rawValue: step.rawValue + 1) ?? .project }
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
      }
      .padding(16)
    }
    .frame(width: 780, height: 620)
    .task { await permissions.refresh() }
  }

  private var welcome: some View {
    VStack(spacing: 18) {
      LogoMark(size: 72)
      Text("Bienvenue dans AvityOne").font(.largeTitle.weight(.semibold))
      Text("Claude Code, Codex, Cursor et OpenCode travaillent directement sur ce Mac, dans tes dossiers.\nAvityOne choisit l’agent, planifie, isole le travail dans des worktrees, fait relire par un autre modèle et partage la mémoire du projet entre tous.")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .frame(maxWidth: 560)
      HStack(spacing: 18) {
        ForEach(["claude", "codex", "cursor", "opencode"], id: \.self) { AgentAvatar(agent: $0, size: 40) }
      }
    }
    .padding(30)
  }

  private var permissionsStep: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Autorisations").font(.title2.weight(.semibold))
      Text("Tout est facultatif et modifiable plus tard dans Réglages → Autorisations.").foregroundStyle(.secondary)
      Form {
        PermissionRow(title: "Notifications", detail: "Savoir quand un agent termine, échoue ou attend ta validation — et la donner depuis la notification.",
                      status: permissions.notifications, grant: { Task { await permissions.requestNotifications() } }, settings: { SystemPermissions.openNotificationSettings() })
        PermissionRow(title: "Micro et reconnaissance vocale", detail: "Dicter tes demandes (⌃M), transcrites sur ce Mac.",
                      status: permissions.microphone == .granted && permissions.speech == .granted ? .granted : (permissions.microphone == .denied || permissions.speech == .denied ? .denied : .undetermined),
                      grant: { Task { await permissions.requestMicrophone(); await permissions.requestSpeech() } }, settings: { SystemPermissions.openPrivacy("Privacy_Microphone") })
        PermissionRow(title: "Enregistrement de l’écran", detail: "Joindre une capture d’écran à une demande.", status: permissions.screen,
                      grant: { permissions.requestScreen() }, settings: { SystemPermissions.openPrivacy("Privacy_ScreenCapture") })
        PermissionRow(title: "Accès complet au disque", detail: "Pour des projets dans Documents, Bureau ou sur un disque externe sans demandes répétées. Les agents en héritent.",
                      status: permissions.fullDisk, grant: nil, settings: { SystemPermissions.openPrivacy("Privacy_AllFiles") })
      }
      .formStyle(.grouped)
    }
    .padding(28)
  }

  private var projectStep: some View {
    VStack(spacing: 16) {
      Image(systemName: "folder.badge.plus").font(.system(size: 44)).foregroundStyle(Palette.accentInk)
      Text("Ton premier projet").font(.title2.weight(.semibold))
      Text("Choisis le dossier d’un dépôt : les agents y travailleront, en local ou dans un worktree isolé par fil.").foregroundStyle(.secondary)
      HStack {
        Button("Choisir un dossier…") { chooseFolder() }.buttonStyle(.borderedProminent)
        Button("Autres options…") { finish(); app.showNewProject = true }
      }
      if !app.projects.isEmpty {
        Text("Projets existants : \(app.projects.map(\.name).joined(separator: ", "))").font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(30)
  }

  private func chooseFolder() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task { if await app.createProject(name: projectName(from: url.lastPathComponent), path: url.path, git: nil) { finish() } }
  }

  private func finish() {
    app.preferences.onboardingDone = true
    dismiss()
  }
}
