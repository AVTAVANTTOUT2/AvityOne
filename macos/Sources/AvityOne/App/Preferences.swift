import SwiftUI
import AvityKit

/// User preferences of the app itself (the engine keeps its own config.json).
@MainActor @Observable final class Preferences {
  static let shared = Preferences()
  private let defaults = UserDefaults.standard

  enum Appearance: String, CaseIterable, Identifiable {
    case system, dark, light
    var id: String { rawValue }
    var label: String { switch self { case .system: "Système"; case .dark: "Sombre"; case .light: "Clair" } }
    var scheme: ColorScheme? { switch self { case .system: nil; case .dark: .dark; case .light: .light } }
  }

  var appearance: Appearance { didSet { defaults.set(appearance.rawValue, forKey: "appearance") } }
  var onboardingDone: Bool { didSet { defaults.set(onboardingDone, forKey: "onboardingDone") } }
  var notifyWhen: NotifyWhen { didSet { defaults.set(notifyWhen.rawValue, forKey: "notifyWhen") } }
  var sounds: Bool { didSet { defaults.set(sounds, forKey: "sounds") } }
  var dictationLanguage: String { didSet { defaults.set(dictationLanguage, forKey: "dictationLanguage") } }
  var openIn: String { didSet { defaults.set(openIn, forKey: "openIn") } }
  var enginePort: Int { didSet { defaults.set(enginePort, forKey: "enginePort") } }
  var profiles: [ServerProfile] { didSet { save(profiles, "profiles") } }
  var activeProfileId: UUID { didSet { defaults.set(activeProfileId.uuidString, forKey: "activeProfile") } }
  var lastProject: [String: Int] { didSet { save(lastProject, "lastProject") } }
  var newThreadsIsolated: Bool { didSet { defaults.set(newThreadsIsolated, forKey: "newThreadsIsolated") } }

  enum NotifyWhen: String, CaseIterable, Identifiable {
    case background, always, never
    var id: String { rawValue }
    var label: String { switch self { case .background: "Quand AvityOne est en arrière-plan"; case .always: "Toujours"; case .never: "Jamais" } }
  }

  struct Language: Identifiable { var id: String; var name: String }
  static let languages = [Language(id: "fr-FR", name: "Français"), Language(id: "en-US", name: "English"), Language(id: "es-ES", name: "Español"),
                          Language(id: "de-DE", name: "Deutsch"), Language(id: "it-IT", name: "Italiano"), Language(id: "pt-PT", name: "Português")]

  private init() {
    appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .dark
    onboardingDone = defaults.bool(forKey: "onboardingDone")
    notifyWhen = NotifyWhen(rawValue: defaults.string(forKey: "notifyWhen") ?? "") ?? .background
    sounds = defaults.object(forKey: "sounds") as? Bool ?? true
    dictationLanguage = defaults.string(forKey: "dictationLanguage") ?? (Locale.preferredLanguages.first?.hasPrefix("fr") == false ? "en-US" : "fr-FR")
    openIn = defaults.string(forKey: "openIn") ?? "com.microsoft.VSCode"
    enginePort = defaults.object(forKey: "enginePort") as? Int ?? 7710
    newThreadsIsolated = defaults.bool(forKey: "newThreadsIsolated")
    let stored: [ServerProfile] = Preferences.load("profiles", from: defaults) ?? []
    profiles = [ServerProfile.local] + stored.filter { !$0.isLocal }
    activeProfileId = UUID(uuidString: defaults.string(forKey: "activeProfile") ?? "") ?? ServerProfile.local.id
    lastProject = Preferences.load("lastProject", from: defaults) ?? [:]
    if !profiles.contains(where: { $0.id == activeProfileId }) { activeProfileId = ServerProfile.local.id }
  }

  var activeProfile: ServerProfile { profiles.first { $0.id == activeProfileId } ?? .local }

  private func save<T: Encodable>(_ value: T, _ key: String) {
    if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: key) }
  }
  private static func load<T: Decodable>(_ key: String, from defaults: UserDefaults) -> T? {
    defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
  }
}
