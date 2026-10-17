import SwiftUI
import AvityKit

struct RootView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var app = app
    Group {
      switch app.connection {
      case .idle, .starting:
        StartingView(message: { if case .starting(let m) = app.connection { return m }; return "Démarrage…" }())
      case .failed(let message):
        FailureView(message: message)
      case .unauthorized:
        TokenView()
      case .ready:
        MainView()
      }
    }
    .overlay(alignment: .bottom) { ToastStack() }
    .sheet(isPresented: $app.showOnboarding) { OnboardingView() }
  }
}

struct StartingView: View {
  var message: String
  var body: some View {
    VStack(spacing: 18) {
      LogoMark(size: 56)
      Text("AvityOne").font(.largeTitle.weight(.semibold))
      ProgressView().controlSize(.small)
      Text(message).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct FailureView: View {
  @Environment(AppModel.self) private var app
  var message: String
  @State private var showLog = false

  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 40)).foregroundStyle(Palette.amber)
      Text(app.isLocal ? "Le moteur local n’a pas démarré" : "Serveur injoignable").font(.title2.weight(.semibold))
      ScrollView { Text(message).font(.callout.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        .frame(maxWidth: 620, maxHeight: 220)
        .padding(10)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
      HStack {
        Button("Réessayer") { Task { await app.connect() } }.keyboardShortcut(.defaultAction)
        if app.isLocal { Button("Journal du moteur") { showLog = true } }
        if !app.isLocal { Button("Revenir à ce Mac") { Task { await app.switchProfile(ServerProfile.local.id) } } }
        SettingsLink { Text("Réglages…") }
      }
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .sheet(isPresented: $showLog) { EngineLogView() }
  }
}

struct EngineLogView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var text = EngineController.shared.log
  var body: some View {
    VStack(alignment: .leading) {
      HStack {
        Text("Journal du moteur").font(.headline)
        Spacer()
        Button("Copier") { copyToPasteboard(text) }
        Button("Actualiser") { text = EngineController.shared.log }
        Button("Fermer") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      ScrollView { Text(text.isEmpty ? "Aucune sortie." : text).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        .background(Palette.card)
    }
    .padding()
    .frame(width: 720, height: 460)
  }
}

/// A remote server without a stored token, or one that refused it.
struct TokenView: View {
  @Environment(AppModel.self) private var app
  @State private var token = ""

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "key.fill").font(.system(size: 36)).foregroundStyle(Palette.accentInk)
      Text("Jeton d’accès requis").font(.title2.weight(.semibold))
      Text("Sur le serveur : jq -r .token ~/.avityone/config.json").font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
      SecureField("Jeton", text: $token).textFieldStyle(.roundedBorder).frame(width: 380)
      HStack {
        Button("Se connecter") {
          Keychain.setToken(token.trimmingCharacters(in: .whitespacesAndNewlines), for: app.preferences.activeProfileId)
          Task { await app.connect() }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(token.isEmpty)
        Button("Revenir à ce Mac") { Task { await app.switchProfile(ServerProfile.local.id) } }
      }
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct ToastStack: View {
  @Environment(AppModel.self) private var app
  var body: some View {
    VStack(spacing: 8) {
      ForEach(app.toasts) { toast in
        HStack(spacing: 8) {
          Image(systemName: toast.error ? "exclamationmark.circle.fill" : "checkmark.circle.fill").foregroundStyle(toast.error ? Palette.red : Palette.green)
          Text(toast.text).lineLimit(3)
        }
        .font(.callout)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .onTapGesture { app.toasts.removeAll { $0.id == toast.id } }
      }
    }
    .padding(.bottom, 24)
    .animation(.spring(duration: 0.3), value: app.toasts)
  }
}
