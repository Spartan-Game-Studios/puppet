// Entry point of the Puppet camera system extension.
import CoreMediaIO
import Foundation

let providerSource = ProviderSource(clientQueue: nil)
CMIOExtensionProvider.startService(provider: providerSource.provider)
CFRunLoopRun()
