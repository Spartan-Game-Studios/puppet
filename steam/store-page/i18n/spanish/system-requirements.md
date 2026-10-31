<!-- Spanish translation (neutral, for both Spanish - Spain and Spanish - Latin America) of the player-facing requirement text in steam/store-page/system-requirements.md. The English file is the source of truth and holds the internal notes (estimates, Mac universal-build check, Steam Deck, storage rationale); apply any change made there here too. Paste each table into Steamworks → Store page → System Requirements with the language dropdown set to each Spanish variant. -->

# Requisitos del sistema

## Windows

| | Mínimos | Recomendados |
|---|---|---|
| SO | Windows 10 de 64 bits (versión 1809 o posterior) | Windows 11 de 64 bits |
| Procesador | Cuatro núcleos, por ejemplo Intel Core i5-6500 / AMD Ryzen 3 1300X | Seis núcleos, por ejemplo Intel Core i5-10400 / AMD Ryzen 5 3600 |
| Memoria | 8 GB de RAM | 16 GB de RAM |
| Gráficos | GPU compatible con WebGL 2 con controladores actualizados, por ejemplo Intel UHD Graphics 620 / NVIDIA GeForce GTX 950 / AMD Radeon RX 460 | NVIDIA GeForce GTX 1060 / AMD Radeon RX 580 o superior |
| Almacenamiento | 500 MB de espacio disponible (más tus avatares y clips) | 1 GB de espacio disponible |
| Notas adicionales | **Se necesita una webcam** (720p a 30 fps o superior). Microsoft Edge WebView2 Runtime (incluido en Windows 11). Cámara virtual: solo apps de cámara de 64 bits; registrarla requiere una solicitud de administrador. Micrófono opcional (lip sync). | Webcam de 1080p; una iluminación frontal uniforme mejora el seguimiento más que una cámara mejor. |

## macOS

| | Mínimos | Recomendados |
|---|---|---|
| SO | macOS 12.3 Monterey | macOS 14 Sonoma o posterior |
| Procesador | Apple M1, o Intel Core i5 de cuatro núcleos (2018 o posterior) | Apple M1 Pro / M2 o posterior |
| Memoria | 8 GB de RAM | 16 GB de RAM |
| Gráficos | Integrados (GPU de Apple silicon o Intel Iris Plus) | GPU de Apple silicon |
| Almacenamiento | 500 MB de espacio disponible (más tus avatares y clips) | 1 GB de espacio disponible |
| Notas adicionales | **Se necesita una webcam** (la cámara FaceTime integrada sirve). La cámara virtual se instala como extensión de cámara y requiere una aprobación en Configuración del Sistema. Micrófono opcional (lip sync). | |

## Linux / SteamOS

| | Mínimos | Recomendados |
|---|---|---|
| SO | Ubuntu 22.04 de 64 bits o equivalente (WebKitGTK 4.1) | Ubuntu 24.04 o equivalente |
| Procesador | Cuatro núcleos, por ejemplo Intel Core i5-6500 / AMD Ryzen 3 1300X | Seis núcleos, por ejemplo Intel Core i5-10400 / AMD Ryzen 5 3600 |
| Memoria | 8 GB de RAM | 16 GB de RAM |
| Gráficos | GPU compatible con WebGL 2 con Mesa 22+ o el controlador propietario de NVIDIA | NVIDIA GeForce GTX 1060 / AMD Radeon RX 580 o superior |
| Almacenamiento | 500 MB de espacio disponible (más tus avatares y clips) | 1 GB de espacio disponible |
| Notas adicionales | **Se necesita una webcam** (V4L2). La cámara virtual necesita el módulo del kernel v4l2loopback. Las teclas globales del sistema necesitan una sesión X11 (no disponibles en Wayland puro). Una ventana transparente necesita un compositor. Micrófono opcional (lip sync). | |
