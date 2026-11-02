// VPuppet Camera: the small app that installs, updates and removes VPuppet's
// camera extension.
//
// macOS activates a system extension only from an app in /Applications, and
// Steam installs VPuppet under ~/Library/Application Support/Steam. So VPuppet
// carries this helper (Contents/Helpers/VPuppet Camera.app, with the extension
// at its Contents/Library/SystemExtensions/), copies it to /Applications and
// runs it with one command:
//
//   VPuppet Camera activate     install, or replace a different version
//   VPuppet Camera deactivate   remove
//   VPuppet Camera properties   report what is installed (installs nothing)
//
// It prints one line per event on stdout, read by PuppetVCamBridge.m:
//
//   approval                      waiting for approval in System Settings
//   activated | deactivated       done
//   reboot                        done after a restart
//   props <enabled> <awaiting> <uninstalling> <version|->   (0/1 flags)
//   failed <code> <message>       OSSystemExtensionErrorCode (or NSError code)
//   timeout                       no answer in time
//
// Opened with no command (double-clicked in /Applications), it asks whether to
// remove the camera, deactivates the extension and moves itself to the Trash.
// That is the uninstall route after VPuppet itself is gone.
//
// No Dock icon (LSUIElement). Frames never pass through here:
// VPuppet writes them into the extension's CMIO sink stream directly, from
// wherever it runs.
import AppKit
import Foundation
import SystemExtensions

let extensionID = "com.spartangamestudios.vpuppet.camera"

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

final class Delegate: NSObject, OSSystemExtensionRequestDelegate {
    let removing: Bool
    /// Each event line, and whether it ends the request (with the exit status).
    let report: (_ line: String, _ exitStatus: Int32?) -> Void
    init(removing: Bool, report: @escaping (String, Int32?) -> Void) {
        self.removing = removing
        self.report = report
    }

    func request(_ request: OSSystemExtensionRequest,
                 actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        // Always take the copy shipped with VPuppet (upgrades and downgrades).
        .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        report("approval", nil)
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        report(result == .willCompleteAfterReboot ? "reboot" : removing ? "deactivated" : "activated", 0)
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let e = error as NSError
        let msg = "\(e.localizedDescription) (\(e.domain) \(e.code))".replacingOccurrences(of: "\n", with: " ")
        report("failed \(e.code) \(msg)", 1)
    }

    func request(_ request: OSSystemExtensionRequest, foundProperties properties: [OSSystemExtensionProperties]) {
        var enabled = false, awaiting = false, uninstalling = false
        var version = ""
        // Several copies can be listed during an update; the enabled one is what runs.
        for p in properties {
            if p.isUninstalling {
                uninstalling = true
                continue
            }
            if p.isEnabled {
                enabled = true
                version = p.bundleVersion
            } else if !enabled {
                version = p.bundleVersion
            }
            if p.isAwaitingUserApproval { awaiting = true }
        }
        let flag = { (b: Bool) in b ? "1" : "0" }
        report("props \(flag(enabled)) \(flag(awaiting)) \(flag(uninstalling && !enabled)) \(version.isEmpty ? "-" : version)", 0)
    }
}

// MARK: - Remove dialog

struct Strings {
    let confirmTitle, confirmBody, remove, cancel, ok: String
    let removed, afterRestart, failed, dragToTrash, embedded: String

    static let en = Strings(
        confirmTitle: "Remove VPuppet Camera?",
        confirmBody: "This removes the VPuppet Virtual Camera from this Mac. VPuppet itself, your settings and your avatars are not touched. You can install it again in VPuppet: VIRTUAL CAM → EXTENSION → INSTALL.",
        remove: "Remove", cancel: "Cancel", ok: "OK",
        removed: "VPuppet Camera has been removed.",
        afterRestart: "VPuppet Camera will be removed when you restart your Mac.",
        failed: "VPuppet Camera could not be removed.",
        dragToTrash: "The camera has been removed. Drag VPuppet Camera from the Applications folder to the Trash.",
        embedded: "This copy of VPuppet Camera is part of VPuppet. Manage the camera in VPuppet: VIRTUAL CAM → EXTENSION.")
    static let ru = Strings(
        confirmTitle: "Удалить VPuppet Camera?",
        confirmBody: "Виртуальная камера VPuppet будет удалена с этого Mac. Сам VPuppet, ваши настройки и аватары останутся. Установить камеру снова можно в VPuppet: ВИРТ. КАМЕРА → РАСШИРЕНИЕ → УСТАНОВИТЬ.",
        remove: "Удалить", cancel: "Отмена", ok: "OK",
        removed: "VPuppet Camera удалена.",
        afterRestart: "VPuppet Camera будет удалена после перезагрузки Mac.",
        failed: "Не удалось удалить VPuppet Camera.",
        dragToTrash: "Камера удалена. Перетащите VPuppet Camera из папки «Программы» в Корзину.",
        embedded: "Эта копия VPuppet Camera входит в VPuppet. Камерой управляет VPuppet: ВИРТ. КАМЕРА → РАСШИРЕНИЕ.")
    static let zhHans = Strings(
        confirmTitle: "移除 VPuppet Camera？",
        confirmBody: "这会从这台 Mac 上移除 VPuppet 虚拟摄像头。VPuppet 本身、你的设置和虚拟形象都不受影响。之后可以在 VPuppet 的 虚拟摄像头 → 扩展 → 安装 中重新安装。",
        remove: "移除", cancel: "取消", ok: "好",
        removed: "VPuppet Camera 已移除。",
        afterRestart: "重新启动 Mac 后，VPuppet Camera 将被移除。",
        failed: "无法移除 VPuppet Camera。",
        dragToTrash: "摄像头已移除。请将“应用程序”文件夹中的 VPuppet Camera 拖到废纸篓。",
        embedded: "这份 VPuppet Camera 是 VPuppet 的一部分。请在 VPuppet 的 虚拟摄像头 → 扩展 中管理摄像头。")
    static let es = Strings(
        confirmTitle: "¿Eliminar VPuppet Camera?",
        confirmBody: "Se eliminará la cámara virtual de VPuppet de este Mac. VPuppet, tus ajustes y tus avatares no se tocan. Puedes volver a instalarla en VPuppet: CÁMARA VIRTUAL → EXTENSIÓN → INSTALAR.",
        remove: "Eliminar", cancel: "Cancelar", ok: "Aceptar",
        removed: "VPuppet Camera se ha eliminado.",
        afterRestart: "VPuppet Camera se eliminará cuando reinicies el Mac.",
        failed: "No se pudo eliminar VPuppet Camera.",
        dragToTrash: "La cámara se ha eliminado. Arrastra VPuppet Camera de la carpeta Aplicaciones a la Papelera.",
        embedded: "Esta copia de VPuppet Camera forma parte de VPuppet. Gestiona la cámara desde VPuppet: CÁMARA VIRTUAL → EXTENSIÓN.")

    /// The first of the user's languages that VPuppet speaks (as in the app).
    static var current: Strings {
        for lang in Locale.preferredLanguages {
            if lang.hasPrefix("en") { return .en }
            if lang.hasPrefix("ru") { return .ru }
            if lang.hasPrefix("zh") { return .zhHans }
            if lang.hasPrefix("es") { return .es }
        }
        return .en
    }
}

@discardableResult
func alert(_ title: String, _ body: String?, _ buttons: [String], style: NSAlert.Style = .informational) -> NSApplication.ModalResponse {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = body ?? ""
    a.alertStyle = style
    for b in buttons { a.addButton(withTitle: b) }
    NSApp.activate(ignoringOtherApps: true)
    return a.runModal()
}

/// After the extension is gone: move this app to the Trash, then say how it went.
func finishRemoval(_ line: String, _ s: Strings) -> Never {
    let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
    let notInstalled = parts.first == "failed" && parts.count > 1
        && Int(parts[1]) == OSSystemExtensionError.Code.extensionNotFound.rawValue
    switch parts.first {
    case "deactivated", "reboot":
        break
    case "failed" where notInstalled:
        break // nothing to deactivate; still remove the app
    default:
        let detail = parts.first == "failed" ? parts.count > 2 ? parts[2] : nil : nil
        alert(s.failed, detail, [s.ok], style: .warning)
        exit(1)
    }
    let trashed = (try? FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)) != nil
    let message = !trashed ? s.dragToTrash : parts.first == "reboot" ? s.afterRestart : s.removed
    alert(message, nil, [s.ok])
    exit(0)
}

func runRemoveDialog() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let s = Strings.current
    // VPuppet's own copy (Contents/Helpers) must stay where it is.
    guard Bundle.main.bundleURL.deletingLastPathComponent().path == "/Applications" else {
        alert("VPuppet Camera", s.embedded, [s.ok])
        exit(0)
    }
    guard alert(s.confirmTitle, s.confirmBody, [s.remove, s.cancel]) == .alertFirstButtonReturn else { exit(0) }
    let delegate = Delegate(removing: true) { line, status in
        guard status != nil else { return }
        DispatchQueue.main.async { finishRemoval(line, s) }
    }
    let request = OSSystemExtensionRequest.deactivationRequest(
        forExtensionWithIdentifier: extensionID, queue: DispatchQueue(label: "vpuppet.camera.helper"))
    request.delegate = delegate
    OSSystemExtensionManager.shared.submitRequest(request)
    DispatchQueue.main.asyncAfter(deadline: .now() + 10 * 60) { finishRemoval("timeout", s) }
    withExtendedLifetime(delegate) { app.run() }
    exit(0)
}

// MARK: - Commands from VPuppet

let command = CommandLine.arguments.dropFirst().first ?? ""
// Finder passes no command (older macOS passed -psn_…).
if command.isEmpty || command.hasPrefix("-") { runRemoveDialog() }
let queue = DispatchQueue(label: "vpuppet.camera.helper")
let request: OSSystemExtensionRequest
let timeout: Double
switch command {
case "activate":
    request = .activationRequest(forExtensionWithIdentifier: extensionID, queue: queue)
    timeout = 30 * 60 // the user may take a while to approve
case "deactivate":
    request = .deactivationRequest(forExtensionWithIdentifier: extensionID, queue: queue)
    timeout = 10 * 60 // macOS may ask for an administrator password
case "properties":
    request = .propertiesRequest(forExtensionWithIdentifier: extensionID, queue: queue)
    timeout = 5 // macOS 26 never answers when nothing is installed
default:
    FileHandle.standardError.write(Data("usage: VPuppet Camera activate|deactivate|properties\n".utf8))
    exit(64)
}
let delegate = Delegate(removing: command == "deactivate") { line, status in
    say(line)
    if let status { exit(status) }
}
request.delegate = delegate
OSSystemExtensionManager.shared.submitRequest(request)
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
    say("timeout")
    exit(2)
}
withExtendedLifetime(delegate) { dispatchMain() }
