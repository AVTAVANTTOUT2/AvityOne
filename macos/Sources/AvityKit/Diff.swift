import Foundation

/// One rendered line of a diff.
public struct DiffLine: Hashable, Sendable, Identifiable {
  public enum Kind: Sendable { case context, added, removed, header, fold }
  public var id: Int
  public var kind: Kind
  public var text: String
  public var oldNumber: Int?
  public var newNumber: Int?
}

/// A hunk of a workspace diff, selectable on its own (`index` is what `selectChange` expects for its file).
public struct DiffHunkView: Hashable, Sendable, Identifiable {
  public var id: String
  public var index: Int?
  public var header: String
  public var lines: [DiffLine]
}

/// One file of a workspace diff with its hunks.
public struct DiffFile: Hashable, Sendable, Identifiable {
  public enum Status: Sendable { case modified, added, deleted }
  public var path: String
  public var status: Status
  public var hunks: [DiffHunkView]
  public var additions: Int
  public var deletions: Int
  public var id: String { path }
  /// New and deleted files are applied whole by the engine: only file-level actions are offered.
  public var wholeFile: Bool { status != .modified }
}

public enum DiffParser {
  /// Groups the engine's hunks (`diffHunks` of src/worktree.ts) by file, numbering them as `selectChange` does.
  public static func files(from hunks: [Hunk]) -> [DiffFile] {
    var order: [String] = []
    var byPath: [String: [Hunk]] = [:]
    for hunk in hunks {
      if byPath[hunk.path] == nil { order.append(hunk.path) }
      byPath[hunk.path, default: []].append(hunk)
    }
    return order.map { path in
      let list = byPath[path]!
      let patch = list.map(\.patch).joined()
      let status: DiffFile.Status = patch.contains("--- /dev/null") ? .added : patch.contains("+++ /dev/null") ? .deleted : .modified
      var adds = 0, dels = 0
      let views = list.enumerated().map { index, hunk -> DiffHunkView in
        let lines = parse(patch: hunk.patch)
        adds += lines.filter { $0.kind == .added }.count
        dels += lines.filter { $0.kind == .removed }.count
        let header = lines.first { $0.kind == .header }?.text ?? ""
        return DiffHunkView(id: hunk.id, index: status == .modified ? index : nil, header: header, lines: lines.filter { $0.kind != .header })
      }
      return DiffFile(path: path, status: status, hunks: views, additions: adds, deletions: dels)
    }
  }

  /// Lines of one patch: file headers dropped, `@@` kept as header lines, numbers tracked on both sides.
  public static func parse(patch: String) -> [DiffLine] {
    var out: [DiffLine] = []
    var old = 0, new = 0, inHunk = false
    for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
      let line = String(raw)
      if line.hasPrefix("@@") {
        inHunk = true
        let numbers = line.split(separator: " ")
        if numbers.count > 2 {
          old = Int(numbers[1].dropFirst().split(separator: ",").first ?? "") ?? 0
          new = Int(numbers[2].dropFirst().split(separator: ",").first ?? "") ?? 0
        }
        out.append(DiffLine(id: out.count, kind: .header, text: line))
        continue
      }
      guard inHunk else { continue }
      if line.hasPrefix("+") {
        out.append(DiffLine(id: out.count, kind: .added, text: String(line.dropFirst()), oldNumber: nil, newNumber: new)); new += 1
      } else if line.hasPrefix("-") {
        out.append(DiffLine(id: out.count, kind: .removed, text: String(line.dropFirst()), oldNumber: old, newNumber: nil)); old += 1
      } else if line.hasPrefix(" ") {
        out.append(DiffLine(id: out.count, kind: .context, text: String(line.dropFirst()), oldNumber: old, newNumber: new)); old += 1; new += 1
      } else if line.hasPrefix("\\") {
        continue
      } else if line.hasPrefix("diff --git") {
        inHunk = false
      }
    }
    return out
  }

  /// Before/after line diff of a tool edit (LCS), unchanged runs folded to 3 lines of context, like the web UI.
  public static func lineDiff(old: String?, new: String?) -> [DiffLine] {
    let a = (old ?? "").isEmpty ? [] : old!.components(separatedBy: "\n")
    let b = (new ?? "").components(separatedBy: "\n")
    var ops: [(Character, String)] = []
    if a.count * b.count > 250_000 {
      ops = a.map { ("-", $0) } + b.map { ("+", $0) }
    } else {
      let n = a.count, m = b.count
      var table = [[UInt16]](repeating: [UInt16](repeating: 0, count: m + 1), count: n + 1)
      if n > 0 && m > 0 {
        for i in stride(from: n - 1, through: 0, by: -1) {
          for j in stride(from: m - 1, through: 0, by: -1) {
            table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] &+ 1 : max(table[i + 1][j], table[i][j + 1])
          }
        }
      }
      var i = 0, j = 0
      while i < n && j < m {
        if a[i] == b[j] { ops.append((" ", a[i])); i += 1; j += 1 }
        else if table[i + 1][j] >= table[i][j + 1] { ops.append(("-", a[i])); i += 1 }
        else { ops.append(("+", b[j])); j += 1 }
      }
      while i < n { ops.append(("-", a[i])); i += 1 }
      while j < m { ops.append(("+", b[j])); j += 1 }
    }
    let changed = ops.map { $0.0 != " " }
    var out: [DiffLine] = []
    var oldNumber = 1, newNumber = 1, folded = false
    for (k, op) in ops.enumerated() {
      let near = changed[max(0, k - 3)...min(ops.count - 1, k + 3)].contains(true)
      defer {
        if op.0 != "+" { oldNumber += 1 }
        if op.0 != "-" { newNumber += 1 }
      }
      if !near {
        if !folded { out.append(DiffLine(id: out.count, kind: .fold, text: "…")) }
        folded = true
        continue
      }
      folded = false
      switch op.0 {
      case "+": out.append(DiffLine(id: out.count, kind: .added, text: op.1, oldNumber: nil, newNumber: newNumber))
      case "-": out.append(DiffLine(id: out.count, kind: .removed, text: op.1, oldNumber: oldNumber, newNumber: nil))
      default: out.append(DiffLine(id: out.count, kind: .context, text: op.1, oldNumber: oldNumber, newNumber: newNumber))
      }
    }
    return out
  }
}
