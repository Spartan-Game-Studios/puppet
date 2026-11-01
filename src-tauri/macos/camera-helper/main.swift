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
// No window and no Dock icon (LSUIElement). Frames never pass through here:
// VPuppet writes them into the extension's CMIO sink stream directly, from
// wherever it runs.
import Foundation
import SystemExtensions

let extensionID = "com.spartangamestudios.vpuppet.camera"

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

final class Delegate: NSObject, OSSystemExtensionRequestDelegate {
    let removing: Bool
    init(removing: Bool) { self.removing = removing }

    func request(_ request: OSSystemExtensionRequest,
                 actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        // Always take the copy shipped with VPuppet (upgrades and downgrades).
        .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        say("approval")
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        say(result == .willCompleteAfterReboot ? "reboot" : removing ? "deactivated" : "activated")
        exit(0)
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let e = error as NSError
        let msg = "\(e.localizedDescription) (\(e.domain) \(e.code))".replacingOccurrences(of: "\n", with: " ")
        say("failed \(e.code) \(msg)")
        exit(1)
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
        say("props \(flag(enabled)) \(flag(awaiting)) \(flag(uninstalling && !enabled)) \(version.isEmpty ? "-" : version)")
        exit(0)
    }
}

let command = CommandLine.arguments.dropFirst().first ?? ""
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
let delegate = Delegate(removing: command == "deactivate")
request.delegate = delegate
OSSystemExtensionManager.shared.submitRequest(request)
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
    say("timeout")
    exit(2)
}
withExtendedLifetime(delegate) { dispatchMain() }
