import XCTest
@testable import AvityKit

/// Decoding of payloads shaped exactly like the engine's (src/hub.ts, src/server.ts) and the client-side logic.
final class ContractTests: XCTestCase {
  func testJSONValueKeepsBooleansAndNumbersApart() throws {
    let value = try JSONValue.parse(#"{"a":1,"b":true,"c":0,"d":false,"e":2.5,"f":"x","g":null,"OPENAI_API_KEY":"k"}"#)
    XCTAssertEqual(value["a"], .number(1))
    XCTAssertEqual(value["b"], .bool(true))
    XCTAssertEqual(value["c"], .number(0))
    XCTAssertEqual(value["d"], .bool(false))
    XCTAssertEqual(value["e"], .number(2.5))
    XCTAssertEqual(value["g"], .null)
    XCTAssertNotNil(value["OPENAI_API_KEY"], "environment variable names stay untouched")
    let again = try JSONValue.parse(value.pretty())
    XCTAssertEqual(again, value)
    XCTAssertTrue(value.pretty(compact: true).contains(#""a":1"#), "integers are written without a decimal part")
  }

  func testSnapshotDecodesSqliteIntegersAndLiveBooleans() throws {
    let json = #"""
    {"session":{"id":"s1","project_id":3,"title":null,"agent":"codex","mode":"plan","acp_session_id":null,"summary":null,"turns":2,
      "summarized_turns":0,"created_at":"2026-10-16 10:00:00","updated_at":"2026-10-16 10:05:00","parent_id":null,"isolated":1,
      "worktree":"/p/.avity/worktrees/s1","pinned":0,"archived":0,"renamed":0,"draft":"brouillon","forked_from":null},
     "state":{"busy":true,"waiting":false,"agent":"codex","mode":"plan","autoApprove":false,"connected":true,"isolated":true,
      "worktree":"/p/.avity/worktrees/s1","modeId":"default","modes":[{"id":"default","name":"Default"}],
      "configOptions":[{"id":"model","name":"Modèle","type":"select","category":"model","currentValue":"gpt-5",
        "options":[{"value":"gpt-5","name":"GPT-5"},{"name":"Autres","options":[{"value":"o9","name":"O9"}]}]},
        {"id":"mode","name":"Mode","type":"select","category":"mode","currentValue":"default","options":[]}],
      "commands":[{"name":"compact","description":"Compacte","input":{"hint":"instructions"}}],"queued":1},
     "items":[
      {"id":1,"type":"user","text":"bonjour","agent":"codex","mode":"plan","reason":"choix manuel","attachments":[{"id":"a","name":"x.png","mime":"image/png","size":3}],
        "content":[{"type":"image","mimeType":"image/png","data":"AAA"}]},
      {"id":2,"type":"thought","agent":"codex","text":"je pense"},
      {"id":3,"type":"tool","toolCallId":"t1","title":"Edit a.txt","status":"in_progress","kind":"edit","paths":["a.txt:3"],"diffs":[{"path":"a.txt","old":"a","new":"b"}]},
      {"id":4,"type":"permission","title":"Edit a.txt","kind":"edit","text":"**ok ?**","options":[{"id":"yes","name":"Allow","kind":"allow_once"},{"id":"no","name":"Reject","kind":"reject_once"}]},
      {"id":5,"type":"plan","entries":[{"content":"A","priority":"high","status":"completed"}]},
      {"id":6,"type":"parallel","children":[{"id":"c1","task":"t","agent":"fake","status":"queued","taskId":"task-1","dependencies":[],"files":[]}]},
      {"id":7,"type":"futur","whatever":true}]}
    """#
    let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
    XCTAssertEqual(snapshot.session.projectId, 3)
    XCTAssertTrue(snapshot.session.isolated)
    XCTAssertFalse(snapshot.session.pinned)
    XCTAssertEqual(snapshot.session.draft, "brouillon")
    XCTAssertEqual(snapshot.session.displayTitle, "Nouveau fil")
    XCTAssertTrue(snapshot.state.busy)
    XCTAssertFalse(snapshot.state.autoApprove)
    XCTAssertEqual(snapshot.state.queued, 1)
    XCTAssertEqual(snapshot.state.selectors.map(\.id), ["model"], "the agent mode stays behind AvityOne's plan switch")
    XCTAssertEqual(snapshot.state.configOptions[0].choices.map(\.name), ["GPT-5", "O9"])
    XCTAssertEqual(snapshot.state.configOptions[0].choices[1].group, "Autres")
    XCTAssertEqual(snapshot.state.configOptions[0].currentName, "GPT-5")
    XCTAssertEqual(snapshot.state.commands.first?.hint, "instructions")
    XCTAssertEqual(snapshot.items.map(\.itemType), [.user, .thought, .tool, .permission, .plan, .parallel, .unknown])
    XCTAssertTrue(snapshot.items[2].isOpenTool)
    XCTAssertTrue(snapshot.items[3].isPendingPermission)
    XCTAssertEqual(snapshot.items[3].options?.filter(\.isAllow).map(\.id), ["yes"])
    XCTAssertEqual(snapshot.items[0].content?.first?.type, "image")
    XCTAssertEqual(snapshot.items[5].children?.first?.status, "queued")
  }

  func testServerEvents() throws {
    let events = [
      #"{"type":"item","sessionId":"s","projectId":1,"item":{"id":9,"type":"assistant","agent":"fake","text":"mode=default"}}"#,
      #"{"type":"state","sessionId":"s","projectId":1,"state":{"busy":false,"waiting":true}}"#,
      #"{"type":"activity","sessionId":"s","projectId":1,"kind":"waiting","title":null,"agent":"fake","text":"Edit a.txt"}"#,
      #"{"type":"sessions","projectId":1}"#,
      #"{"type":"reset","sessionId":"s","projectId":1,"fromId":4}"#,
      #"{"type":"validation","sessionId":"s","id":2,"status":"running","command":"npm test"}"#,
      #"{"type":"nouveau"}"#,
    ].map { try ServerEvent.decode(Data($0.utf8)) }
    guard case .item(_, _, let item) = events[0] else { return XCTFail("item") }
    XCTAssertEqual(item.text, "mode=default")
    guard case .state(_, _, let state) = events[1] else { return XCTFail("state") }
    XCTAssertTrue(state.waiting); XCTAssertTrue(state.autoApprove, "absent fields keep the engine default")
    guard case .activity(let activity) = events[2] else { return XCTFail("activity") }
    XCTAssertEqual(activity.kind, "waiting")
    guard case .sessions(let project) = events[3] else { return XCTFail("sessions") }
    XCTAssertEqual(project, 1)
    guard case .reset(_, _, let from) = events[4] else { return XCTFail("reset") }
    XCTAssertEqual(from, 4)
    guard case .validation(_, let payload) = events[5] else { return XCTFail("validation") }
    XCTAssertEqual(payload["command"]?.string, "npm test")
    guard case .unknown(let type) = events[6] else { return XCTFail("unknown") }
    XCTAssertEqual(type, "nouveau")
  }

  func testSSEParserHandlesSplitChunksCRLFCommentsAndNamedEvents() {
    var parser = SSEParser()
    var messages = parser.feed(Array(": ok\n\ndata: {\"a\":".utf8))
    XCTAssertTrue(messages.isEmpty)
    messages += parser.feed(Array("1}\n\nevent: ping\r\ndata: {}\r\n\r\ndata: x\ndata: y\n\n".utf8))
    XCTAssertEqual(messages, [
      .init(event: "message", data: #"{"a":1}"#),
      .init(event: "ping", data: "{}"),
      .init(event: "message", data: "x\ny"),
    ])
  }

  func testFeedUpsertResetTurnsAndActivity() {
    var feed = Feed()
    feed.upsert(Item(id: 1, type: "user", text: "q"))
    feed.upsert(Item(id: 2, type: "assistant", text: "a"))
    feed.upsert(Item(id: 2, type: "assistant", text: "ab"))
    feed.upsert(Item(id: 3, type: "end"))
    feed.upsert(Item(id: 5, type: "user", text: "q2"))
    feed.upsert(Item(id: 4, type: "info", text: "inséré"))
    XCTAssertEqual(feed.items.map(\.id), [1, 2, 3, 4, 5])
    XCTAssertEqual(feed.items[1].text, "ab")
    feed.upsert(Item(id: 6, type: "error", text: "échec"))
    let (turns, retry) = feed.turns()
    XCTAssertEqual(turns[3], Feed.Turn(copy: "ab", before: 5))
    XCTAssertEqual(retry, 6)
    var tool = Item(id: 7, type: "tool"); tool.kind = "read"; tool.status = "in_progress"; tool.paths = ["src/app.ts:1"]
    feed.upsert(tool)
    XCTAssertEqual(feed.activityLabel(), "lit app.ts:1")
    XCTAssertEqual(feed.agent(at: 6), nil)
    feed.reset(from: 5)
    XCTAssertEqual(feed.items.map(\.id), [1, 2, 3, 4])
  }

  func testWorkspaceHunksAreGroupedAndNumberedPerFile() {
    let patchA = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-un\n+one\n deux\n"
    let patchA2 = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -20,1 +20,2 @@\n vingt\n+vingt et un\n"
    let added = "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+nouveau\n"
    let files = DiffParser.files(from: [Hunk(id: "h1", path: "a.txt", patch: patchA), Hunk(id: "h2", path: "a.txt", patch: patchA2), Hunk(id: "h3", path: "n.txt", patch: added)])
    XCTAssertEqual(files.map(\.path), ["a.txt", "n.txt"])
    XCTAssertEqual(files[0].hunks.map(\.index), [0, 1])
    XCTAssertEqual(files[0].additions, 2)
    XCTAssertEqual(files[0].deletions, 1)
    XCTAssertEqual(files[0].hunks[1].lines.map(\.newNumber), [20, 21])
    XCTAssertTrue(files[1].wholeFile)
    XCTAssertEqual(files[1].hunks[0].index, nil)
  }

  func testToolLineDiffFoldsUnchangedRuns() {
    let old = (1...20).map { "ligne \($0)" }.joined(separator: "\n")
    let new = old.replacingOccurrences(of: "ligne 10", with: "ligne dix")
    let lines = DiffParser.lineDiff(old: old, new: new)
    XCTAssertEqual(lines.filter { $0.kind == .removed }.map(\.text), ["ligne 10"])
    XCTAssertEqual(lines.filter { $0.kind == .added }.map(\.text), ["ligne dix"])
    XCTAssertEqual(lines.filter { $0.kind == .fold }.count, 2)
    XCTAssertEqual(lines.first { $0.kind == .added }?.newNumber, 10)
  }

  func testProjectNamesAndServerURLs() {
    XCTAssertEqual(projectName(from: "Mon Projet été"), "Mon-Projet-ete")
    XCTAssertEqual(projectName(from: "…"), "projet")
    XCTAssertEqual(ServerProfile.normalize(" https://avityone.tail5feb4c.ts.net/api/ ")?.absoluteString, "https://avityone.tail5feb4c.ts.net")
    XCTAssertNil(ServerProfile.normalize("ftp://x"))
    XCTAssertNil(ServerProfile.normalize("pas une url"))
  }

  func testServerDates() {
    XCTAssertNotNil(parseServerDate("2026-10-16 10:05:00"))
    XCTAssertNotNil(parseServerDate("2026-10-16T10:05:00.123Z"))
    XCTAssertNil(parseServerDate(""))
  }

  func testRequestsUseBearerJsonAndNoCookies() throws {
    let client = APIClient(baseURL: URL(string: "http://127.0.0.1:7710")!, token: "jeton")
    let request = try client.makeRequest("POST", "/sessions/s1/prompt", body: ["text": "x"])
    XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7710/api/sessions/s1/prompt")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer jeton")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    let get = try client.makeRequest("GET", "/projects/1/search", query: ["q": "é & x"])
    XCTAssertNil(get.httpBody)
    XCTAssertTrue(get.url!.absoluteString.hasSuffix("/api/projects/1/search?q=%C3%A9%20%26%20x"))
    XCTAssertNil(client.session.configuration.httpCookieStorage)
  }

  func testLoopbackPorts() throws {
    let port = try XCTUnwrap(bindableLoopbackPort())
    XCTAssertGreaterThan(port, 0)
  }
}
