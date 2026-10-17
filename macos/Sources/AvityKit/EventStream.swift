import Foundation

/// Incremental parser of a text/event-stream (only what the engine sends: `event`, `data` and comments).
public struct SSEParser {
  public struct Message: Equatable, Sendable { public var event: String; public var data: String }
  var line: [UInt8] = []
  var event = ""
  var data: [String] = []
  var lastWasCR = false

  public init() {}

  public mutating func feed<S: Sequence>(_ bytes: S) -> [Message] where S.Element == UInt8 {
    var out: [Message] = []
    for byte in bytes {
      if byte == 0x0A && lastWasCR { lastWasCR = false; continue }
      lastWasCR = byte == 0x0D
      if byte == 0x0A || byte == 0x0D {
        if let m = endLine() { out.append(m) }
      } else {
        line.append(byte)
      }
    }
    return out
  }

  mutating func endLine() -> Message? {
    defer { line.removeAll(keepingCapacity: true) }
    let text = String(decoding: line, as: UTF8.self)
    if text.isEmpty {
      defer { event = ""; data = [] }
      guard !data.isEmpty else { return nil }
      return Message(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
    }
    if text.hasPrefix(":") { return nil }
    let field: Substring, value: Substring
    if let colon = text.firstIndex(of: ":") {
      field = text[..<colon]
      var rest = text[text.index(after: colon)...]
      if rest.hasPrefix(" ") { rest = rest.dropFirst() }
      value = rest
    } else { field = Substring(text); value = "" }
    switch field {
    case "event": event = String(value)
    case "data": data.append(String(value))
    default: break
    }
    return nil
  }
}

/// `/api/events`, kept alive like the web client: the server pings every 25 s, so 70 s of silence means a dead link
/// (a sleeping Mac, a dropped VPN). Reconnection backs off from 1 to 30 s and reports `reconnected` so the caller
/// can resync with REST, since the stream has no replay.
public final class EventStream: @unchecked Sendable {
  public enum Link: Sendable { case connecting, open, lost, unauthorized }

  let client: APIClient
  let onEvent: @Sendable (ServerEvent) -> Void
  let onLink: @Sendable (Link) -> Void
  let onReconnect: @Sendable () -> Void
  private var task: Task<Void, Never>?
  private let lock = NSLock()
  private var heard = Date()

  public init(client: APIClient, onEvent: @escaping @Sendable (ServerEvent) -> Void, onLink: @escaping @Sendable (Link) -> Void, onReconnect: @escaping @Sendable () -> Void) {
    self.client = client
    self.onEvent = onEvent
    self.onLink = onLink
    self.onReconnect = onReconnect
  }

  public func start() {
    stop()
    task = Task.detached(priority: .userInitiated) { [weak self] in await self?.run() }
  }

  public func stop() {
    task?.cancel()
    task = nil
  }

  private func touch() { lock.lock(); heard = Date(); lock.unlock() }
  private var silence: TimeInterval { lock.lock(); defer { lock.unlock() }; return Date().timeIntervalSince(heard) }

  private func run() async {
    var retry = 0
    var everOpened = false
    var lost = false
    while !Task.isCancelled {
      onLink(.connecting)
      do {
        var request = try client.makeRequest("GET", "/events")
        request.timeoutInterval = 24 * 3600
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await client.session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { onLink(.unauthorized); return }
        guard status == 200 else { throw APIError(status: status, message: "flux d’événements indisponible (\(status))") }
        touch()
        retry = 0
        onLink(.open)
        if everOpened && lost { onReconnect() }
        everOpened = true
        lost = false
        try await withThrowingTaskGroup(of: Void.self) { group in
          group.addTask { [self] in
            var parser = SSEParser()
            var buffer: [UInt8] = []
            buffer.reserveCapacity(4096)
            for try await byte in bytes {
              buffer.append(byte)
              // Flush on every newline so pings and small events are not held back.
              if byte == 0x0A {
                for message in parser.feed(buffer) {
                  touch()
                  if message.event == "message", let event = try? ServerEvent.decode(Data(message.data.utf8)) { onEvent(event) }
                }
                buffer.removeAll(keepingCapacity: true)
              }
            }
            throw APIError(status: 0, message: "flux fermé par le moteur")
          }
          group.addTask { [self] in
            while !Task.isCancelled {
              try await Task.sleep(nanoseconds: 10_000_000_000)
              if silence > 70 { throw APIError(status: 0, message: "flux silencieux") }
            }
          }
          _ = try await group.next()
          group.cancelAll()
        }
      } catch {
        if Task.isCancelled { return }
      }
      lost = true
      onLink(.lost)
      let delay = min(30.0, pow(2.0, Double(retry)))
      retry += 1
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
    }
  }
}
