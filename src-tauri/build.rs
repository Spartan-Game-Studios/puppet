fn main() {
    // macOS: the app-side virtual camera bridge (Objective-C, ARC). It drives
    // OSSystemExtensionRequest and writes frames into the CoreMediaIO camera
    // extension's sink stream; see src/vcam/macos.rs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=macos/bridge/PuppetVCamBridge.m");
        cc::Build::new()
            .file("macos/bridge/PuppetVCamBridge.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacosx-version-min=12.0")
            .warnings(true)
            .compile("puppet_vcam_bridge");
        for fw in ["Foundation", "SystemExtensions", "CoreMediaIO", "CoreMedia", "CoreVideo"] {
            println!("cargo:rustc-link-lib=framework={fw}");
        }
    }
    tauri_build::build()
}
