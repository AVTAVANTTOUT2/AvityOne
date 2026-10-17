// Minimal `pdftotext` for the embedded engine (src/knowledge.ts calls `pdftotext -layout <file> -`): a stock Mac has
// no Poppler, PDFKit extracts the text layer. Poppler, when installed, comes first in the engine's PATH.
import Foundation
import PDFKit

let arguments = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") || $0 == "-" }
guard let input = arguments.first, input != "-" else {
  FileHandle.standardError.write(Data("usage : pdftotext [-layout] <fichier.pdf> [-|sortie.txt]\n".utf8))
  exit(99)
}
guard let document = PDFDocument(url: URL(fileURLWithPath: input)) else {
  FileHandle.standardError.write(Data("pdftotext : PDF illisible : \(input)\n".utf8))
  exit(1)
}
if document.isLocked {
  FileHandle.standardError.write(Data("pdftotext : PDF protégé par mot de passe\n".utf8))
  exit(3)
}
var pages: [String] = []
for index in 0..<document.pageCount {
  pages.append(document.page(at: index)?.string ?? "")
}
// Poppler separates pages with a form feed.
let text = Data((pages.joined(separator: "\u{0C}") + "\u{0C}").utf8)
let output = arguments.dropFirst().first ?? "-"
if output == "-" {
  FileHandle.standardOutput.write(text)
} else {
  do { try text.write(to: URL(fileURLWithPath: output)) } catch {
    FileHandle.standardError.write(Data("pdftotext : écriture impossible : \(output)\n".utf8))
    exit(2)
  }
}
