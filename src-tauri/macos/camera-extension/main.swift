// Entry point of the VPuppet camera system extension.
import CoreMediaIO
import Foundation

let providerSource = ProviderSource(clientQueue: nil)
CMIOExtensionProvider.startService(provider: providerSource.provider)
CFRunLoopRun()
