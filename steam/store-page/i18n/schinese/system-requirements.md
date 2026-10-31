<!-- Simplified Chinese translation of the player-facing requirement text in steam/store-page/system-requirements.md. The English file is the source of truth and holds the internal notes (estimates, Mac universal-build check, Steam Deck, storage rationale); apply any change made there here too. Paste each table into Steamworks → Store page → System Requirements with the language dropdown set to Simplified Chinese. -->

# 系统需求

## Windows

| | 最低配置 | 推荐配置 |
|---|---|---|
| 操作系统 | Windows 10 64 位（1809 或更高版本） | Windows 11 64 位 |
| 处理器 | 四核，例如 Intel Core i5-6500 / AMD Ryzen 3 1300X | 六核，例如 Intel Core i5-10400 / AMD Ryzen 5 3600 |
| 内存 | 8 GB RAM | 16 GB RAM |
| 显卡 | 支持 WebGL 2 并安装最新驱动的显卡，例如 Intel UHD Graphics 620 / NVIDIA GeForce GTX 950 / AMD Radeon RX 460 | NVIDIA GeForce GTX 1060 / AMD Radeon RX 580 或更高 |
| 存储空间 | 500 MB 可用空间（另需存放你的模型和动画片段） | 1 GB 可用空间 |
| 附注事项 | **需要摄像头**（720p 30 fps 或更高）。需要 Microsoft Edge WebView2 Runtime（Windows 11 已自带）。虚拟摄像头：仅支持 64 位摄像头软件；注册时需要一次管理员授权。麦克风可选（用于口型同步）。 | 1080p 摄像头；正面光线均匀对追踪效果的提升，比换一个更好的摄像头更明显。 |

## macOS

| | 最低配置 | 推荐配置 |
|---|---|---|
| 操作系统 | macOS 12.3 Monterey | macOS 14 Sonoma 或更高版本 |
| 处理器 | Apple M1，或 Intel Core i5 四核（2018 年或更新机型） | Apple M1 Pro / M2 或更高 |
| 内存 | 8 GB RAM | 16 GB RAM |
| 显卡 | 集成显卡（Apple 芯片 GPU 或 Intel Iris Plus） | Apple 芯片 GPU |
| 存储空间 | 500 MB 可用空间（另需存放你的模型和动画片段） | 1 GB 可用空间 |
| 附注事项 | **需要摄像头**（内置 FaceTime 摄像头即可）。虚拟摄像头以摄像头扩展的形式安装，需要在“系统设置”中批准一次。麦克风可选（用于口型同步）。 | |

## Linux / SteamOS

| | 最低配置 | 推荐配置 |
|---|---|---|
| 操作系统 | 64 位 Ubuntu 22.04 或同等系统（WebKitGTK 4.1） | Ubuntu 24.04 或同等系统 |
| 处理器 | 四核，例如 Intel Core i5-6500 / AMD Ryzen 3 1300X | 六核，例如 Intel Core i5-10400 / AMD Ryzen 5 3600 |
| 内存 | 8 GB RAM | 16 GB RAM |
| 显卡 | 支持 WebGL 2 的显卡，配合 Mesa 22+ 或 NVIDIA 专有驱动 | NVIDIA GeForce GTX 1060 / AMD Radeon RX 580 或更高 |
| 存储空间 | 500 MB 可用空间（另需存放你的模型和动画片段） | 1 GB 可用空间 |
| 附注事项 | **需要摄像头**（V4L2）。虚拟摄像头需要 v4l2loopback 内核模块。全局热键需要 X11 会话（纯 Wayland 下不可用）。透明窗口需要合成器。麦克风可选（用于口型同步）。 | |
