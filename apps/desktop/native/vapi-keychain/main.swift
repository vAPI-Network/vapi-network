import Foundation
import Security
import LocalAuthentication

let service = "ai.vapinetwork.desktop"
let notFound: Int32 = 44

func fail(_ message: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func baseQuery(_ account: String) -> [String: Any] {
    return [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecUseDataProtectionKeychain as String: true,
    ]
}

func get(_ account: String) {
    let context = LAContext()
    context.localizedReason = "unlock vAPI Desktop"
    var query = baseQuery(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationContext as String] = context
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { exit(notFound) }
    if status != errSecSuccess { fail("keychain read failed: \(status)") }
    guard let data = item as? Data else { fail("keychain returned no data") }
    FileHandle.standardOutput.write(data)
    exit(0)
}

func set(_ account: String) {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    var value = input
    if let last = value.last, last == 0x0A { value.removeLast() }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.biometryCurrentSet, .or, .devicePasscode],
        &error
    ) else { fail("access control: \(String(describing: error))") }
    SecItemDelete(baseQuery(account) as CFDictionary)
    var add = baseQuery(account)
    add[kSecValueData as String] = value
    add[kSecAttrAccessControl as String] = access
    let status = SecItemAdd(add as CFDictionary, nil)
    if status != errSecSuccess { fail("keychain write failed: \(status)") }
    exit(0)
}

func delete(_ account: String) {
    let status = SecItemDelete(baseQuery(account) as CFDictionary)
    if status == errSecItemNotFound { exit(notFound) }
    if status != errSecSuccess { fail("keychain delete failed: \(status)") }
    exit(0)
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: vapi-keychain get|set|delete <account>", 2) }
switch args[1] {
case "get": get(args[2])
case "set": set(args[2])
case "delete": delete(args[2])
default: fail("usage: vapi-keychain get|set|delete <account>", 2)
}
