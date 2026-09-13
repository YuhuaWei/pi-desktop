// pi 桌面版 - Electron 主进程
// 启动时自动拉起后端服务（带健康检查），创建独立窗口，关窗自动停止
const { app, BrowserWindow, session, ipcMain } = require('electron');
const { spawn, exec } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("disable-smooth-scrolling");
// 强制 GPU：ANGLE D3D11（解决软件渲染回退）
app.commandLine.appendSwitch("use-angle", "d3d11");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("disable-software-rasterizer");

const PORT = 8787;
// 路径自动检测（环境变量可覆盖：PI_HOME / PI_NODE / PI_WORKDIR）
const PI_HOME = process.env.PI_HOME || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'pi-node', 'current');
const NODE = process.env.PI_NODE || path.join(PI_HOME, 'node.exe');
const SERVER = path.join(__dirname, 'web', 'server.mjs');
const CWD = process.env.PI_WORKDIR || process.env.USERPROFILE || __dirname;
const LOG = path.join(__dirname, 'app.log');

let serverProc = null;

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

process.on('uncaughtException', (err) => log('uncaught: ' + (err?.stack || err)));
process.on('unhandledRejection', (err) => log('unhandledRejection: ' + (err?.stack || err)));

/** 健康检查：请求 /api/info，确认服务器真的能响应 */
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(!!j.ok && !!j.piVersion);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 等待服务器健康 */
async function waitForHealth(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 杀掉占用端口的进程（服务器不健康时） */
function killPortOwner() {
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ' + PORT + ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"',
      () => resolve()
    );
  });
}

/** 查询 Windows 实际刷新率（Electron screen API 报告不准，用 WMI 查） */
function getWindowsRefreshRate() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(60), 3000);
    exec(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty CurrentRefreshRate)"',
      (err, stdout) => {
        clearTimeout(timer);
        const rate = parseInt((stdout || '').trim(), 10);
        resolve(rate > 0 ? rate : 60);
      }
    );
  });
}

/** 确保服务器可用：健康→复用；不健康→杀掉占用者，启动自己的 */
async function ensureServer() {
  if (await checkHealth()) {
    log('server healthy, reuse existing');
    return true;
  }
  log('server unhealthy or not running, killing port owner...');
  await killPortOwner();
  await new Promise((r) => setTimeout(r, 800));
  log('spawning server: ' + NODE + ' ' + SERVER);
  serverProc = spawn(NODE, [SERVER], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stdout.on('data', (d) => log('srv: ' + d.toString().trim()));
  serverProc.stderr.on('data', (d) => log('srv-err: ' + d.toString().trim()));
  serverProc.on('error', (e) => log('srv-spawn-err: ' + e.message));
  serverProc.on('exit', (code) => log('srv-exit: ' + code));
  const ok = await waitForHealth();
  log('server ready: ' + ok);
  return ok;
}

app.whenReady().then(async () => {
  await session.defaultSession.clearCache().catch(() => {});
  await session.defaultSession.clearStorageData().catch(() => {});
  log('app ready, args=' + JSON.stringify(process.argv.slice(1)));
  try {
    const gpuStatus = app.getGPUFeatureStatus();
    log('GPU status: ' + JSON.stringify(gpuStatus));
  } catch (e) { log('GPU status error: ' + e.message); }
  const ok = await ensureServer();

  // 查询 Windows 实际刷新率并设置帧率上限（165Hz 显示器 -> 165fps）
  const refreshRate = await getWindowsRefreshRate();
  log('windows refresh rate: ' + refreshRate + 'Hz');

  const win = new BrowserWindow({
    width: 1320,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'pi',
    frame: false,
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.webContents.setFrameRate(Math.max(refreshRate, 60));
  log('frame rate set to ' + Math.max(refreshRate, 60) + 'fps');

  if (ok) {
    await win.loadURL(`http://localhost:${PORT}/?v=${Date.now()}`);
    log('window loaded: http://localhost:' + PORT);
  } else {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h2 style="font-family:sans-serif;color:#eee;text-align:center;margin-top:40%">backend failed to start, see app.log</h2>'));
    log('window loaded: fallback error page');
  }
  win.on('closed', stopServer);
});

function stopServer() {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
    log('server stopped');
  }
}

// 窗口控制 IPC（伪标题栏按钮）
ipcMain.on('win-control', (e, action) => {
  log("win-control received: " + action);
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
});

app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});
