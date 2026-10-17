import AppKit
import UserNotifications

/// System notifications for finished, failed and waiting sessions. A permission request carries Allow / Deny
/// actions answered from the notification itself.
@MainActor final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Notifier()
  var onOpen: ((String) -> Void)?
  var onPermission: ((String, Int, String) -> Void)?

  func setup() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let allow = UNNotificationAction(identifier: "allow", title: "Autoriser une fois", options: [])
    let deny = UNNotificationAction(identifier: "deny", title: "Refuser", options: [.destructive])
    center.setNotificationCategories([UNNotificationCategory(identifier: "permission", actions: [allow, deny], intentIdentifiers: [], options: [])])
  }

  func requestAuthorization() async -> Bool {
    (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
  }

  struct PermissionActions { var permId: Int; var allow: String?; var deny: String? }

  func post(title: String, body: String, sessionId: String, permission: PermissionActions? = nil, sound: Bool) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.threadIdentifier = sessionId
    var info: [String: Any] = ["sessionId": sessionId]
    if let permission {
      content.categoryIdentifier = "permission"
      info["permId"] = permission.permId
      if let allow = permission.allow { info["allow"] = allow }
      if let deny = permission.deny { info["deny"] = deny }
    }
    content.userInfo = info
    if sound { content.sound = .default }
    let request = UNNotificationRequest(identifier: "\(sessionId)-\(permission?.permId ?? 0)-\(Date().timeIntervalSince1970)", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }

  func clear(sessionId: String) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ids = delivered.filter { $0.request.content.threadIdentifier == sessionId }.map(\.request.identifier)
      center.removeDeliveredNotifications(withIdentifiers: ids)
    }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                          withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                          withCompletionHandler completionHandler: @escaping () -> Void) {
    let info = response.notification.request.content.userInfo
    let action = response.actionIdentifier
    let sessionId = info["sessionId"] as? String
    let permId = info["permId"] as? Int
    let option = action == "allow" ? info["allow"] as? String : action == "deny" ? info["deny"] as? String : nil
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        guard let sessionId else { return }
        if let permId, let option { Notifier.shared.onPermission?(sessionId, permId, option) }
        else {
          NSApp.activate(ignoringOtherApps: true)
          Notifier.shared.onOpen?(sessionId)
        }
      }
    }
    completionHandler()
  }
}
