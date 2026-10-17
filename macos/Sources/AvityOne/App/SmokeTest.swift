import AppKit
import CoreText
import AvityKit

/// `AvityOne --smoke-test` (CI): the bundle's own engine starts, answers with its token, finds the bundled npm and
/// the `avity` CLI, extracts a PDF with the PDFKit helper, then stops. Exit code 0 when everything holds.
enum SmokeTest {
  final class Result: @unchecked Sendable { var failures: [String] = [] }

  static func run() -> Int32 {
    let done = DispatchSemaphore(value: 0)
    let result = Result()
    Task.detached {
      result.failures = await check()
      done.signal()
    }
    done.wait()
    let failures = result.failures
    for failure in failures { FileHandle.standardError.write(Data("ÉCHEC \(failure)\n".utf8)) }
    print(failures.isEmpty ? "Test de fumée réussi." : "Test de fumée : \(failures.count) échec(s).")
    return failures.isEmpty ? 0 : 1
  }

  private static func check() async -> [String] {
    var failures: [String] = []
    func expect(_ condition: Bool, _ what: String) {
      print("\(condition ? "ok   " : "ÉCHEC") \(what)")
      if !condition { failures.append(what) }
    }
    let engine = EngineController.shared
    do {
      let endpoint = try await engine.start(preferredPort: bindableLoopbackPort(0) ?? 7710)
      expect(endpoint.url.host == "127.0.0.1", "le moteur n’écoute que sur la boucle locale")
      let client = APIClient(baseURL: endpoint.url, token: endpoint.token)
      let state = try await client.state()
      expect(!state.projects.isEmpty, "projet par défaut créé")
      expect(state.agents.contains { $0.id == "claude" } && state.agents.contains { $0.id == "codex" }, "catalogue des agents")
      let catalog = try await client.agents()
      expect(catalog.first { $0.id == "opencode" }?.catalog?.loginCommand.first == "opencode", "commande de connexion exposée")

      let env = engine.environment(port: endpoint.port)
      let path = env["PATH"] ?? ""
      expect(path.contains(engine.tools.appendingPathComponent("bin").path) && path.contains("/opt/homebrew/bin"), "PATH complet pour les agents")
      let npm = ShellEnvironment.which("npm", path: path) ?? ""
      expect(npm.hasPrefix(engine.nodeURL.deletingLastPathComponent().path), "npm embarqué trouvé en premier (\(npm))")

      let cli = Toolchain.run(engine.tools.appendingPathComponent("bin/avity").path, ["projects"])
      expect(cli.status == 0 && cli.output.contains("perso"), "commande avity (\(cli.output.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)))")

      let pdf = FileManager.default.temporaryDirectory.appendingPathComponent("avity-smoke.pdf")
      writePDF(pdf, text: "AvityOne PDF fumée")
      let extracted = Toolchain.run(engine.helpersURL.appendingPathComponent("pdftotext").path, ["-layout", pdf.path, "-"])
      expect(extracted.status == 0 && extracted.output.contains("AvityOne PDF"), "assistant pdftotext (PDFKit)")

      await Task.detached { engine.stop() }.value
      expect(!engine.isRunning, "arrêt du moteur")
    } catch {
      failures.append("moteur : \(error.localizedDescription)\n\(engine.log)")
    }
    return failures
  }

  private static func writePDF(_ url: URL, text: String) {
    var box = CGRect(x: 0, y: 0, width: 400, height: 200)
    guard let context = CGContext(url as CFURL, mediaBox: &box, nil) else { return }
    context.beginPDFPage(nil)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 18)]))
    context.textPosition = CGPoint(x: 24, y: 100)
    CTLineDraw(line, context)
    context.endPDFPage()
    context.closePDF()
  }
}
