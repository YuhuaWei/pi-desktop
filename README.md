# pi-desktop

pi（终端 AI 编程代理）的桌面版与网页版界面 —— 基于 pi SDK 的第三方 GUI，提供类似现代 AI 聊天客户端的体验。

> 本项目不是 pi 官方项目，是一个把 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 Agent 能力包装成桌面应用的独立实现。使用前需要先安装 pi。

## ✨ 特性

- **会话管理**：侧边栏会话列表、切换、新建、右键删除，历史消息完整还原
- **流式对话**：SSE 实时输出，思考块（thinking）与耗时统计、命令块（工具调用与输出）可折叠展示
- **斜杠命令**：`/` 呼出命令面板，支持模型、思考级别、压缩等命令
- **模型配置**：界面内切换模型、思考强度、配置 provider 与 API Key
- **附件支持**：图片（base64 直传视觉模型）与文本文件（路径注入，让 Agent 自行读取）
- **主题**：亮色 / 暗色一键切换
- **自定义滚动引擎**：transform 硬件加速、亚像素平滑、惯性滚动、越界橡皮筋回弹（鼠标与触控板一致的物理手感）
- **悬浮输入框**：浏览历史时对话从输入框下方穿过
- **无边框窗口**：自绘标题栏与窗口按钮

## 🏗 架构

```
pi-desktop/
├── main.js              # Electron 主进程：启动后端服务、健康检查、无边框窗口、IPC
├── preload.js           # 渲染进程桥接（窗口控制 / 文件路径）
├── package.json
├── start-app.bat        # Windows 启动脚本
└── web/
    ├── server.mjs       # 本地 HTTP 服务：pi SDK 会话管理 + SSE 流式接口
    ├── start-web.bat    # 仅启动后端（浏览器访问 http://localhost:8787）
    ├── start-desktop.bat
    └── public/
        ├── index.html   # 前端单文件（UI + 滚动引擎 + 命令系统）
        └── favicon.svg
```

- **后端**（`web/server.mjs`）：用 pi SDK（`createAgentSession`）创建 Agent 会话，通过 HTTP + SSE 提供 API；端口默认 `8787`
- **前端**（`web/public/index.html`）：单文件应用，自定义滚动引擎（transform 平移 + 惯性 + 橡皮筋）
- **桌面壳**（`main.js`）：Electron 启动时自动拉起后端（带健康检查与超时重试），窗口加载前端页面

## 📦 环境要求

- **Node.js**：随 pi 一起安装（pi-node 自带），无需单独安装
- **pi**：已安装且完成登录（`~/.pi/agent/auth.json`）
- **Electron**：`npm install` 会自动安装（首次约 300 MB）

## 🚀 安装与运行

```bash
git clone <repo-url> pi-desktop
cd pi-desktop
npm install          # 安装 Electron
```

**Windows**：双击 `start-app.bat`（或创建快捷方式指向它）

**仅后端 + 浏览器**：

```bash
node web/server.mjs
# 然后浏览器打开 http://localhost:8787
```

## ⚙️ 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_HOME` | pi-node 安装目录（含 `node.exe` 与 SDK） | `%LOCALAPPDATA%\pi-node\current` |
| `PI_NODE` | node 可执行文件路径 | `%PI_HOME%\node.exe` |
| `PI_WORKDIR` | Agent 工作目录（会话根目录） | `%USERPROFILE%` |
| `PORT` | 后端服务端口 | `8787` |

## 🔧 已知问题与修复

### keep-alive 僵尸连接（卡死 5 分钟）

pi 的 HTTP 客户端（undici）会复用 keep-alive 连接。当中转设备**静默断开**连接（不发 FIN）后，客户端察觉不到，下次请求复用这条"僵尸连接"→ 数据发进黑洞 → 等待超时才报错。

本项目在 `web/server.mjs` 启动时主动调用 pi 的 `configureHttpDispatcher()` 修复：

- keep-alive 空闲 **2 秒**即回收连接（默认 4 秒），连接最长寿命 20 秒
- HTTP 空闲超时（headers/body）默认 **90 秒**（原默认 5 分钟），可用 pi 的 `settings.json` 中 `httpIdleTimeoutMs` 调整

> 注：该能力需要 pi 的 `dist/index.js` 导出 `configureHttpDispatcher`，0.85.x 已验证可用。

## 📄 License

MIT
