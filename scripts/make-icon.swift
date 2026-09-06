import AppKit

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()

let canvas = NSRect(origin: .zero, size: size)
let background = NSBezierPath(roundedRect: canvas.insetBy(dx: 48, dy: 48), xRadius: 220, yRadius: 220)
let gradient = NSGradient(colors: [
    NSColor(calibratedRed: 0.05, green: 0.12, blue: 0.22, alpha: 1),
    NSColor(calibratedRed: 0.04, green: 0.48, blue: 0.55, alpha: 1),
])!
gradient.draw(in: background, angle: -42)

let inner = NSBezierPath(roundedRect: canvas.insetBy(dx: 156, dy: 156), xRadius: 160, yRadius: 160)
NSColor.white.withAlphaComponent(0.13).setFill()
inner.fill()

let symbolConfig = NSImage.SymbolConfiguration(pointSize: 430, weight: .semibold)
let symbol = NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: nil)!
    .withSymbolConfiguration(symbolConfig)!
symbol.isTemplate = true
NSColor.white.set()
symbol.draw(in: NSRect(x: 282, y: 282, width: 460, height: 460), from: .zero, operation: .sourceOver, fraction: 1)

image.unlockFocus()
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: destination)
