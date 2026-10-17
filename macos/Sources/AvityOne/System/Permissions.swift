import AppKit
import AVFoundation
import CoreGraphics
import Speech
import SwiftUI
import UserNotifications

/// macOS privacy permissions the app and its engine rely on. Child processes (engine, agents, terminals) inherit
/// the app's grants: macOS attributes their file access to AvityOne.
@MainActor @Observable final class SystemPermissions {
  enum Status: Equatable {
    case granted, denied, undetermined, unknown
    var label: String {
      switch self {
      case .granted: "Autorisé"
      case .denied: "Refusé"
      case .undetermined: "Non demandé"
      case .unknown: "Non accordé"
      }
    }
    var color: Color {
      switch self {
      case .granted: Palette.green
      case .denied: Palette.red
      case .undetermined, .unknown: Palette.amber
      }
    }
  }

  static let shared = SystemPermissions()
  var notifications: Status = .unknown
  var microphone: Status = .unknown
  var speech: Status = .unknown
  var screen: Status = .unknown
  var fullDisk: Status = .unknown

  func refresh() async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    switch settings.authorizationStatus {
    case .authorized, .provisional: notifications = .granted
    case .denied: notifications = .denied
    case .notDetermined: notifications = .undetermined
    @unknown default: notifications = .unknown
    }
    microphone = Self.map(AVCaptureDevice.authorizationStatus(for: .audio))
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: speech = .granted
    case .denied, .restricted: speech = .denied
    case .notDetermined: speech = .undetermined
    @unknown default: speech = .unknown
    }
    screen = CGPreflightScreenCaptureAccess() ? .granted : .unknown
    fullDisk = Self.hasFullDiskAccess() ? .granted : .unknown
  }

  private static func map(_ status: AVAuthorizationStatus) -> Status {
    switch status {
    case .authorized: .granted
    case .denied, .restricted: .denied
    case .notDetermined: .undetermined
    @unknown default: .unknown
    }
  }

  /// The TCC database is only readable with Full Disk Access.
  static func hasFullDiskAccess() -> Bool {
    let tcc = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
    guard let handle = try? FileHandle(forReadingFrom: tcc) else { return false }
    try? handle.close()
    return true
  }

  func requestNotifications() async { _ = await Notifier.shared.requestAuthorization(); await refresh() }
  func requestMicrophone() async { _ = await AVCaptureDevice.requestAccess(for: .audio); await refresh() }
  func requestSpeech() async {
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in SFSpeechRecognizer.requestAuthorization { _ in done.resume() } }
    await refresh()
  }
  func requestScreen() { if !CGRequestScreenCaptureAccess() { Self.openPrivacy("Privacy_ScreenCapture") } }

  static func openPrivacy(_ anchor: String) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") { NSWorkspace.shared.open(url) }
  }
  static func openNotificationSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") { NSWorkspace.shared.open(url) }
  }
}
