// Renders the AvityOne icon (the LogoMark of web/src/brand.tsx on a dark macOS tile) into an .iconset folder.
// Usage: swift make-icon.swift <AppIcon.iconset>   then   iconutil -c icns <AppIcon.iconset>
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func color(_ hex: UInt32) -> CGColor {
  CGColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

func diamond(center: CGPoint, radius: CGFloat) -> CGPath {
  let path = CGMutablePath()
  path.move(to: CGPoint(x: center.x, y: center.y + radius))
  path.addLine(to: CGPoint(x: center.x + radius, y: center.y))
  path.addLine(to: CGPoint(x: center.x, y: center.y - radius))
  path.addLine(to: CGPoint(x: center.x - radius, y: center.y))
  path.closeSubpath()
  return path
}

func fill(_ context: CGContext, _ path: CGPath, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
  context.saveGState()
  context.addPath(path)
  context.clip()
  let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: nil)!
  context.drawLinearGradient(gradient, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
  context.restoreGState()
}

func render(_ pixels: Int) -> Data {
  let size = CGFloat(pixels)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let context = NSGraphicsContext.current!.cgContext
  // Apple's icon grid: an 824/1024 tile with continuous-looking corners.
  let inset = size * 100 / 1024
  let tile = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
  let shape = CGPath(roundedRect: tile, cornerWidth: tile.width * 0.225, cornerHeight: tile.width * 0.225, transform: nil)
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -size * 0.012), blur: size * 0.03, color: CGColor(gray: 0, alpha: 0.45))
  context.addPath(shape)
  context.setFillColor(color(0x121212))
  context.fillPath()
  context.restoreGState()
  fill(context, shape, [color(0x1D2230), color(0x0B0C10)], from: CGPoint(x: tile.minX, y: tile.maxY), to: CGPoint(x: tile.maxX, y: tile.minY))
  // A quiet blue glow behind the mark.
  context.saveGState()
  context.addPath(shape)
  context.clip()
  let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [CGColor(red: 0, green: 0.44, blue: 0.99, alpha: 0.35), CGColor(red: 0, green: 0.44, blue: 0.99, alpha: 0)] as CFArray, locations: nil)!
  context.drawRadialGradient(glow, startCenter: CGPoint(x: size / 2, y: size / 2), startRadius: 0, endCenter: CGPoint(x: size / 2, y: size / 2), endRadius: tile.width * 0.55, options: [])
  context.restoreGState()
  let center = CGPoint(x: size / 2, y: size / 2)
  let outer = tile.width * 0.33
  fill(context, diamond(center: center, radius: outer), [color(0x9CC5FF), color(0x0071FC)],
       from: CGPoint(x: center.x - outer, y: center.y + outer), to: CGPoint(x: center.x + outer, y: center.y - outer))
  let inner = outer * 0.47
  fill(context, diamond(center: center, radius: inner), [color(0xD9CCFF), color(0x6D5DFC)],
       from: CGPoint(x: center.x + inner, y: center.y + inner), to: CGPoint(x: center.x - inner, y: center.y - inner))
  context.addPath(diamond(center: center, radius: outer))
  context.setStrokeColor(CGColor(gray: 1, alpha: 0.25))
  context.setLineWidth(max(1, size * 0.004))
  context.strokePath()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for (name, pixels) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256),
                       ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
  try render(pixels).write(to: output.appendingPathComponent("icon_\(name).png"))
}
