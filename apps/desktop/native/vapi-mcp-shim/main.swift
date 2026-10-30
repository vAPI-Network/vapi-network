import Foundation
import Darwin

let notRunning = "vAPI Desktop is not running. Open it from Applications and try again."
let env = ProcessInfo.processInfo.environment

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(2)
}

signal(SIGPIPE, SIG_IGN)
guard let socketPath = env["VAPI_DESKTOP_SOCKET"], !socketPath.isEmpty else {
    fail("VAPI_DESKTOP_SOCKET is not set.")
}
guard socketPath.utf8.count < 104 else {
    fail("VAPI_DESKTOP_SOCKET is too long: sun_path allows at most 103 UTF-8 bytes.")
}
let bundleId = env["VAPI_DESKTOP_BUNDLE_ID"] ?? "ai.vapinetwork.desktop"
let attempts = max(0, Int(env["VAPI_DESKTOP_CONNECT_ATTEMPTS"] ?? "") ?? 40)
let delayMs = max(0, Int(env["VAPI_DESKTOP_CONNECT_DELAY_MS"] ?? "") ?? 500)

func connectSocket(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let pathBytes = path.utf8CString
    _ = withUnsafeMutablePointer(to: &address.sun_path) { destination in
        pathBytes.withUnsafeBytes { source in
            memcpy(destination, source.baseAddress!, source.count)
        }
    }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if result == 0 { return fd }
    close(fd)
    return -1
}

@Sendable
func writeAll(_ fd: Int32, _ bytes: UnsafeRawBufferPointer) -> Bool {
    var offset = 0
    while offset < bytes.count {
        let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0 {
            if errno == EINTR { continue }
            return false
        }
        if count == 0 { return false }
        offset += count
    }
    return true
}

func writeData(_ fd: Int32, _ data: Data) -> Bool {
    return data.withUnsafeBytes { writeAll(fd, $0) }
}

func helloLine() -> Data {
    var hello: [String: Any] = ["vapiDesktop": 1]
    if let wallet = env["VAPI_DESKTOP_WALLET"], !wallet.isEmpty { hello["wallet"] = wallet }
    var data = try! JSONSerialization.data(withJSONObject: hello, options: [.sortedKeys])
    data.append(0x0A)
    return data
}

func launchApp() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-g", "-b", bundleId]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        // A failed launch still gets the same socket retries and per-request error.
    }
}

func connectWithLaunch() -> Int32 {
    let first = connectSocket(socketPath)
    if first >= 0 { return first }
    launchApp()
    for _ in 0..<attempts {
        Thread.sleep(forTimeInterval: Double(delayMs) / 1000)
        let fd = connectSocket(socketPath)
        if fd >= 0 { return fd }
    }
    return -1
}

func answerNotRunning() -> Never {
    while let line = readLine(strippingNewline: true) {
        var id: Any = NSNull()
        if let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)),
           let request = object as? [String: Any] {
            id = request["id"] ?? NSNull()
        }
        let reply: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "error": ["code": -32000, "message": notRunning],
        ]
        var data = try! JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])
        data.append(0x0A)
        if !writeData(STDOUT_FILENO, data) { exit(0) }
    }
    exit(0)
}

func forward(_ source: Int32, _ destination: Int32) {
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let count = buffer.withUnsafeMutableBytes {
            Darwin.read(source, $0.baseAddress!, $0.count)
        }
        if count < 0 {
            if errno == EINTR { continue }
            return
        }
        if count == 0 { return }
        let written = buffer.withUnsafeBytes {
            writeAll(destination, UnsafeRawBufferPointer(rebasing: $0[..<count]))
        }
        if !written { return }
    }
}

let fd = connectWithLaunch()
if fd < 0 { answerNotRunning() }
if !writeData(fd, helloLine()) { exit(0) }
let reader = Thread {
    forward(fd, STDOUT_FILENO)
    exit(0)
}
reader.start()
forward(STDIN_FILENO, fd)
shutdown(fd, SHUT_WR)

// Keep the reader alive to drain replies after stdin's write side closes.
let drained = NSCondition()
drained.lock()
while true { drained.wait() }
