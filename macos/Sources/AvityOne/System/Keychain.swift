import Foundation
import Security

/// Tokens of remote servers live in the login keychain, never in UserDefaults.
enum Keychain {
  static let service = "fr.avityone.AvityOne.server"

  static func token(for profile: UUID) -> String? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: profile.uuidString, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  @discardableResult
  static func setToken(_ token: String, for profile: UUID) -> Bool {
    let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: profile.uuidString]
    SecItemDelete(base as CFDictionary)
    var item = base
    item[kSecValueData as String] = Data(token.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  static func removeToken(for profile: UUID) {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: profile.uuidString]
    SecItemDelete(query as CFDictionary)
  }
}
