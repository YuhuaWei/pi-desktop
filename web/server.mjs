/**
 * pi Web 版 - 本地服务器
 * 用 pi 的 SDK 创建 agent 会话，通过 HTTP + SSE 提供浏览器聊天界面
 * 支持：会话列表 / 切换 / 新建 / 历史消息 / 斜杠命令
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

// ---- 配置 ----
const PORT = process.env.PORT || 8787;
// pi-node 目录自动检测（环境变量可覆盖：PI_HOME）
const PI_HOME = process.env.PI_HOME || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'pi-node', 'current');
const PI_PKG = path.join(PI_HOME, 'node_modules', '@earendil-works', 'pi-coding-agent');
const PI_SDK = pathToFileURL(path.join(PI_PKG, 'dist', 'index.js')).href;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- 加载 pi SDK ----
if (!fs.existsSync(fileURLToPath(PI_SDK))) {
  console.error("==========================================");
  console.error("  [pi-web] pi SDK not found: " + PI_SDK);
  console.error("  pi may have been updated/reinstalled.");
  console.error("  Fix: update PI_SDK path in server.mjs");
  console.error("==========================================");
  process.exit(1);
}
const { createAgentSession, SessionManager, ModelRuntime, ModelRegistry } = await import(PI_SDK);
const SDK_VERSION = JSON.parse(fs.readFileSync(path.join(PI_PKG, 'package.json'), "utf8")).version;
console.log(`[pi-web] pi SDK loaded, version: ${SDK_VERSION}`);
const CWD = process.cwd();

// ---- 全局状态 ----
let session = null;        // 当前 AgentSession
let sessionInfo = null;    // 当前会话信息 {id, path, name}
let busy = false;
let modelRuntime = null;   // 模型/认证运行时
// ---- 思考耗时持久化（历史渲染用）----
const THINK_FILE = path.join(__dirname, 'think-times.json');
let thinkTimes = {};
try { thinkTimes = JSON.parse(fs.readFileSync(THINK_FILE, 'utf8')); } catch {}
let _thinkSaveTimer = null;
function saveThinkTimes() {
  clearTimeout(_thinkSaveTimer);
  _thinkSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(THINK_FILE, JSON.stringify(thinkTimes)); } catch {}
  }, 500);
}
let modelRegistry = null;  // 模型注册表
const clients = new Set();

// ---------- 模型 ----------

async function getModelRuntime() {
  if (!modelRuntime) {
    modelRuntime = await ModelRuntime.create();
    modelRegistry = new ModelRegistry(modelRuntime);
  }
  return modelRuntime;
}

/** 可用模型列表 */
function listModels() {
  if (!modelRegistry) return [];
  const current = session?.state?.model?.id ?? '';
  return modelRegistry.getAvailable().map((m) => ({
    id: m.id,
    provider: m.provider,
    displayName: m.displayName ?? m.id,
    current: m.id === current,
    authConfigured: modelRegistry.hasConfiguredAuth(m),
  }));
}


/** 可用 provider 列表（从模型目录反推） */
function listProviders() {
  if (!modelRegistry) return [];
  const models = modelRegistry.getAll();
  const byProv = {};
  for (const m of models) byProv[m.provider] = (byProv[m.provider] || 0) + 1;
  const out = [];
  for (const [id, count] of Object.entries(byProv)) {
    const auth = modelRegistry.getProviderAuthStatus(id);
    out.push({
      id,
      displayName: modelRegistry.getProviderDisplayName(id) || id,
      modelCount: count,
      configured: !!auth?.configured,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** auth.json 路径 */
function authFilePath() {
  return path.join(process.env.USERPROFILE || os.homedir(), ".pi", "agent", "auth.json");
}

/** 写入 provider API key（格式与 pi 终端一致） */
function saveApiKey(provider, key) {
  const file = authFilePath();
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  auth[provider] = { type: "api_key", key };
  fs.writeFileSync(file, JSON.stringify(auth, null, 2));
  console.log(`[pi-web] auth.json updated: ${provider}`);
}

/** 移除 provider API key */
function removeApiKey(provider) {
  const file = authFilePath();
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  delete auth[provider];
  fs.writeFileSync(file, JSON.stringify(auth, null, 2));
  console.log(`[pi-web] auth.json updated: removed ${provider}`);
}

/** 重建运行时与会话（配置变更后调用，保持当前会话） */
async function reconfigureRuntime() {
  modelRuntime = await ModelRuntime.create();
  modelRegistry = new ModelRegistry(modelRuntime);
  if (session) {
    const currentPath = session.sessionFile;
    session.dispose();
    session = null;
    sessionInfo = null;
    await attachSession(SessionManager.open(currentPath));
  }
}
// ---------- 会话 ----------

function getToolName(partial) {
  for (const c of partial?.content ?? []) {
    if (c.type === 'tool_use' && c.name) return c.name;
  }
  return 'tool';
}

function serializeEvent(e) {
  if (e.type === 'message_update') {
    const a = e.assistantMessageEvent;
    if (!a) return null;
    if (a.type === 'text_delta') return { type: 'text', delta: a.delta };
    if (a.type === 'thinking_delta') return { type: 'thinking', delta: a.delta };
    if (a.type === 'toolcall_start') return { type: 'tool', name: getToolName(a.partial) };
    if (a.type === 'toolcall_end') return { type: 'tool_end' };
    return null;
  }
  if (e.type === 'tool_execution_start') {
    let args = '';
    try { args = typeof e.args === 'string' ? e.args : JSON.stringify(e.args ?? '').slice(0, 120); } catch { args = ''; }
    return { type: 'tool_start', name: e.toolName, args };
  }
  if (e.type === 'tool_execution_update') {
    let res = '';
    try { res = typeof e.partialResult === 'string' ? e.partialResult : JSON.stringify(e.partialResult ?? ''); } catch { res = ''; }
    return { type: 'tool_update', name: e.toolName, result: res.slice(0, 4000) };
  }
  if (e.type === 'tool_execution_end') {
    let res = '';
    try { res = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? ''); } catch { res = ''; }
    return { type: 'tool_end', name: e.toolName, result: res.slice(0, 4000), isError: !!e.isError };
  }
  if (e.type === 'agent_settled') return { type: 'done' };
  return null;
}

function writeSSE(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(payload) {
  for (const res of clients) writeSSE(res, payload);
}

/** 创建（或打开）一个 agent 会话并挂上全局事件订阅 */
async function attachSession(sessionManager) {
  const runtime = await getModelRuntime();
  const { session: s } = await createAgentSession({ cwd: CWD, sessionManager, modelRuntime: runtime });
  session = s;
  // 思考耗时跟踪（按 assistant 消息序号，从已有消息数开始，与历史提取序号一致）
  let thinkIdx = (session.state?.messages || []).filter((m) => m.role === 'assistant').length;
  let thinkStartMs = null;
  session.subscribe((e) => {
    if (e.type === 'message_start' && e.message?.role === 'assistant') {
      thinkIdx++;
      thinkStartMs = null;
    }
    if (e.type === 'message_update') {
      const a = e.assistantMessageEvent;
      if (a?.type === 'thinking_start' && thinkStartMs === null) thinkStartMs = Date.now();
      if ((a?.type === 'text_start' || a?.type === 'toolcall_start') && thinkStartMs !== null) {
        const sid = session?.sessionId;
        if (sid) {
          if (!thinkTimes[sid]) thinkTimes[sid] = {};
          thinkTimes[sid][thinkIdx] = ((Date.now() - thinkStartMs) / 1000).toFixed(1);
          saveThinkTimes();
        }
        thinkStartMs = null;
      }
    }
    const msg = serializeEvent(e);
    if (msg) broadcast(msg);
  });
  sessionInfo = {
    id: session.sessionId ?? 'unknown',
    path: session.sessionFile ?? '',
    name: session.name ?? '',
  };
  return session;
  console.log("[pi-web] sessionInfo: " + JSON.stringify(sessionInfo).slice(0, 150));
}

/** 首次启动：继续最近的会话（没有则新建） */
async function initSession() {
  if (session) return session;
  try {
    await attachSession(SessionManager.continueRecent(CWD));
  } catch {
    await attachSession(SessionManager.create(CWD));
  }
  console.log(`[pi-web] session ready: ${sessionInfo.id}`);
  return session;
}

/** 会话列表（最新在前） */
async function listSessions() {
  const list = await SessionManager.list(CWD);
  return list
    .sort((a, b) => b.modified - a.modified)
    .map((s) => ({
      id: s.id,
      path: s.path,
      name: s.name || s.firstMessage.slice(0, 40) || '(empty)',
      firstMessage: s.firstMessage,
      messageCount: s.messageCount,
      modified: s.modified.toISOString(),
      active: sessionInfo?.path === s.path,
    }));
}

/** 从消息状态里提取文本 + 思考 + 工具调用块（历史渲染用） */
function extractMessages() {
  const msgs = session?.state?.messages ?? [];
  const out = [];
  let pendingTool = null; // 跨消息绑定工具结果（toolResult 在 user 消息里）
  let assistantCount = 0;
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.role === 'assistant') assistantCount++;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const blocks = [];
    let textBuf = '';
    const flush = () => { if (textBuf.trim()) { blocks.push({ type: 'text', text: textBuf }); textBuf = ''; } };
    for (const c of parts) {
      if (c.type === 'text') { textBuf += c.text ?? ''; }
      else if (c.type === 'thinking') {
        flush();
        const sid = session?.sessionId;
        const secs = (sid && thinkTimes[sid] && thinkTimes[sid][assistantCount]) || null;
        blocks.push({ type: 'thinking', text: String(c.thinking ?? c.text ?? '').slice(0, 20000), secs });
      }
      else if (c.type === 'toolCall') {
        flush();
        let args = '';
        try { args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? ''); } catch { args = ''; }
        const tb = { type: 'tool', name: c.name, args: args.slice(0, 500) };
        blocks.push(tb);
        pendingTool = tb;
      }
      else if (c.type === 'toolResult') {
        if (pendingTool) {
          let res = '';
          try { res = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''); } catch { res = ''; }
          pendingTool.result = res.slice(0, 20000);
          pendingTool.isError = !!c.is_error;
          pendingTool = null;
        }
      }
    }
    flush();
    if (blocks.length) out.push({ role: m.role, blocks });
  }
  return out;
}
// ---------- 斜杠命令 ----------

const COMMANDS = {
  model:     { desc: '切换模型', args: '<provider/model>' },
  name:      { desc: '重命名当前会话', args: '<名称>' },
  new:       { desc: '新建会话' },
  compact:   { desc: '压缩当前会话上下文' },
  session:   { desc: '查看当前会话信息' },
  usage:     { desc: '查看 token 用量与费用' },
  copy:      { desc: '复制最后一条 AI 回复（浏览器端执行）' },
  export:    { desc: '导出会话 (jsonl/html)' },
  abort:     { desc: '中止当前任务' },
  login:     { desc: '配置 provider API key', args: '<provider>' },
  logout:    { desc: '移除 provider 认证', args: '<provider>' },
  providers: { desc: '列出所有 provider' },
  models:    { desc: '列出可用模型' },
  help:      { desc: '显示所有命令' },
};

/** 执行命令，返回 { type: 'ok'|'error', message, data? } */
async function runCommand(cmd, args) {
  const s = await initSession();
  switch (cmd) {
    case 'help': {
      const lines = Object.entries(COMMANDS).map(([k, v]) => `/${k} ${v.args ?? ''} - ${v.desc}`);
      return { type: 'ok', message: lines.join('\n') };
    }
    case 'models': {
      const models = listModels();
      return { type: 'ok', message: '可用模型：', data: { models } };
    }
    case 'model': {
      if (!args) return { type: 'error', message: '用法: /model <provider/model>' };
      const [provider, id] = args.trim().split('/');
      const model = modelRegistry?.find(provider, id ?? provider);
      if (!model) return { type: 'error', message: `未找到模型: ${args}` };
      if (!modelRegistry.hasConfiguredAuth(model)) return { type: 'error', message: `模型 ${args} 未配置认证` };
      await s.setModel(model);
      return { type: 'ok', message: `已切换到模型: ${args}` };
    }
    case 'name': {
      if (!args?.trim()) return { type: 'error', message: '用法: /name <名称>' };
      s.setSessionName(args.trim());
      sessionInfo.name = args.trim();
      return { type: 'ok', message: `会话已重命名为: ${args.trim()}` };
    }
    case 'new': {
      if (busy) return { type: 'error', message: '任务处理中，无法新建会话' };
      if (session) session.dispose();
      await attachSession(SessionManager.create(CWD));
      return { type: 'ok', message: '已创建新会话', data: { newSession: true } };
    }
    case 'compact': {
      const result = await s.compact();
      return { type: 'ok', message: `压缩完成: ${result?.summary ? result.summary.slice(0, 200) : '(无摘要)'}` };
    }
    case 'session': {
      const stats = s.getSessionStats();
      return { type: 'ok', message:
        `会话 ID: ${stats.sessionId}\n` +
        `消息数: 用户 ${stats.userMessages} / 助手 ${stats.assistantMessages} / 工具 ${stats.toolCalls}\n` +
        `Token: ${stats.tokens.total} (入 ${stats.tokens.input} / 出 ${stats.tokens.output})\n` +
        `费用: $${(stats.cost ?? 0).toFixed(4)}`
      };
    }
    case 'usage': {
      const stats = s.getSessionStats();
      return { type: 'ok', message:
        `输入: ${stats.tokens.input} tokens\n` +
        `输出: ${stats.tokens.output} tokens\n` +
        `缓存读: ${stats.tokens.cacheRead} / 写: ${stats.tokens.cacheWrite}\n` +
        `总计: ${stats.tokens.total} tokens\n` +
        `费用: $${(stats.cost ?? 0).toFixed(4)}`
      };
    }
    case 'export': {
      const fmt = (args?.trim() || 'jsonl').toLowerCase();
      if (fmt === 'jsonl') {
        const content = fs.readFileSync(session.sessionFile, 'utf8');
        return { type: 'ok', message: '导出成功', data: { export: { filename: `${session.sessionId}.jsonl`, content } } };
      }
      if (fmt === 'html') {
        const msgs = extractMessages();
        const body = msgs.map((m) => {
          const text = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          const tools = (m.blocks || []).filter((b) => b.type === 'tool').map((b) => '[工具] ' + b.name + ' ' + (b.args || '')).join('\n');
          return '<div class="m ' + m.role + '"><b>' + (m.role === 'user' ? '你' : 'pi') + ':</b><pre>' + escapeHtml(text + (tools ? '\n' + tools : '')) + '</pre></div>';
        }).join('\n');
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pi session</title>
<style>body{font-family:sans-serif;max-width:800px;margin:20px auto;background:#111;color:#eee;padding:0 16px}
.m{margin:16px 0}.m pre{white-space:pre-wrap;background:#1a1f2b;padding:12px;border-radius:8px}
.m.user b{color:#4f8cff}.m.assistant b{color:#4ade80}</style></head><body>${body}</body></html>`;
        return { type: 'ok', message: '导出成功', data: { export: { filename: `${session.sessionId}.html`, content: html } } };
      }
      return { type: 'error', message: '格式仅支持 jsonl 或 html' };
    }
    case 'abort': {
      await s.abort();
      return { type: 'ok', message: '已中止当前任务' };
    }
    case 'login': {
      const p = args?.trim() || '';
      if (!p) return { type: 'ok', message: '用法: /login <provider>（输入 /providers 查看列表）', data: { openProvider: true } };
      return { type: 'ok', message: '请在弹窗中为 ' + p + ' 输入 API key', data: { openProvider: p } };
    }
    case 'logout': {
      const p = args?.trim();
      if (!p) return { type: 'error', message: '用法: /logout <provider>' };
      await getModelRuntime();
      removeApiKey(p);
      await reconfigureRuntime();
      return { type: 'ok', message: '已移除 ' + p + ' 的认证' };
    }
    case 'providers': {
      const provs = listProviders();
      const lines = provs.map((x) => x.id + ' [' + (x.configured ? '已配置' : '未配置') + '] - ' + x.modelCount + ' 模型');
      return { type: 'ok', message: '可用 providers：\\n' + lines.join('\\n') };
    }
    case 'copy': {
      return { type: 'ok', message: '请在浏览器端执行（Ctrl+C）', data: { clientOnly: 'copy' } };
    }
    default:
      return { type: 'error', message: `未知命令: /${cmd}（输入 /help 查看所有命令）` };
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

process.on('uncaughtException', (e) => console.error('[crash] uncaught:', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[crash] unhandled:', e?.stack || e));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ---- 发送消息（SSE 流式返回）----
  if (req.method === 'POST' && p === '/api/prompt') {
    if (busy) return sendJSON(res, 409, { error: '上一个任务还在处理中，请稍候…' });
    const body = await readBody(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message && !(body.images && body.images.length)) return sendJSON(res, 400, { error: '消息不能为空' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'meta', cwd: process.cwd() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));

    try {
      const s = await initSession();
      busy = true;
      const promptOpts = {};
      if (Array.isArray(body.images) && body.images.length) {
        // 只保留图片附件
        promptOpts.images = body.images.filter((im) => im && im.data && /^image\//.test(im.mimeType || ''));
      }
      await s.prompt(message, promptOpts);
    } catch (err) {
      writeSSE(res, { type: 'error', message: String(err?.message ?? err) });
    } finally {
      busy = false;
      writeSSE(res, { type: 'done' });
      res.end();
      clients.delete(res);
    }
    return;
  }

  // ---- 斜杠命令 ----
  if (req.method === 'POST' && p === '/api/command') {
    const body = await readBody(req);
    const cmd = String(body.command || '').replace(/^\//, '').trim();
    const args = typeof body.args === 'string' ? body.args.trim() : '';
    if (!cmd) return sendJSON(res, 400, { error: '缺少命令' });
    try {
      const result = await runCommand(cmd, args);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { type: 'error', message: String(e?.message ?? e) });
    }
  }

  // ---- 命令列表 ----
  if (req.method === 'GET' && p === '/api/commands') {
    return sendJSON(res, 200, { commands: Object.entries(COMMANDS).map(([k, v]) => ({ name: k, ...v })) });
  }

  // ---- provider 列表 ----
  if (req.method === "GET" && p === "/api/providers") {
    try { await initSession(); return sendJSON(res, 200, { providers: listProviders() }); }
    catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 配置 provider API key ----
  if (req.method === "POST" && p === "/api/provider") {
    const body = await readBody(req);
    const provider = String(body.provider || "").trim();
    const key = String(body.key || "").trim();
    if (!provider || !key) return sendJSON(res, 400, { error: "provider 和 key 不能为空" });
    try {
      await getModelRuntime();
      saveApiKey(provider, key);
      await reconfigureRuntime();
      console.log(`[pi-web] provider configured: ${provider}`);
      return sendJSON(res, 200, { ok: true, providers: listProviders(), models: listModels() });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 移除 provider 认证 ----
  if (req.method === "POST" && p === "/api/provider/remove") {
    const body = await readBody(req);
    const provider = String(body.provider || "").trim();
    if (!provider) return sendJSON(res, 400, { error: "provider 不能为空" });
    try {
      removeApiKey(provider);
      await reconfigureRuntime();
      console.log(`[pi-web] provider removed: ${provider}`);
      return sendJSON(res, 200, { ok: true, providers: listProviders(), models: listModels() });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 模型列表 ----
  if (req.method === 'GET' && p === '/api/models') {
    try { await initSession(); return sendJSON(res, 200, { models: listModels() }); }
    catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 设置思考强度 ----
  if (req.method === "POST" && p === "/api/thinking") {
    const body = await readBody(req);
    const level = body.level;
    try {
      const s = await initSession();
      const levels = s.getAvailableThinkingLevels();
      if (!levels.includes(level)) return sendJSON(res, 400, { error: `不可用的思考级别: ${level}（可用: ${levels.join("/")}）` });
      s.setThinkingLevel(level);
      return sendJSON(res, 200, { thinkingLevel: s.state.thinkingLevel, thinkingLevels: s.getAvailableThinkingLevels() });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 会话列表 ----
  if (req.method === 'GET' && p === '/api/sessions') {
    try { return sendJSON(res, 200, { sessions: await listSessions() }); }
    catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 新建会话 ----
  if (req.method === 'POST' && p === '/api/sessions') {
    if (busy) return sendJSON(res, 409, { error: '任务处理中，无法切换会话' });
    try {
      if (session) session.dispose();
      await attachSession(SessionManager.create(CWD));
      return sendJSON(res, 200, { id: sessionInfo.id, name: sessionInfo.name });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 切换会话 ----
  if (req.method === 'POST' && p === '/api/sessions/switch') {
    if (busy) return sendJSON(res, 409, { error: '任务处理中，无法切换会话' });
    const body = await readBody(req);
    const sPath = body.path;
    if (!sPath) return sendJSON(res, 400, { error: '缺少 path' });
    try {
      if (session) session.dispose();
      await attachSession(SessionManager.open(sPath));
      return sendJSON(res, 200, { id: sessionInfo.id, name: sessionInfo.name, messages: extractMessages() });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 删除会话 ----
  if (req.method === 'POST' && p === '/api/sessions/delete') {
    const body = await readBody(req);
    const sPath = body.path;
    if (!sPath) return sendJSON(res, 400, { error: '缺少 path' });
    try {
      // 删除会话文件
      if (!fs.existsSync(sPath)) return sendJSON(res, 404, { error: '会话不存在' });
      fs.unlinkSync(sPath);
      console.log('[pi-web] session deleted: ' + sPath);
      // 如果删除的是当前会话：切到最近的
      if (session && session.sessionFile === sPath) {
        session.dispose();
        session = null;
        sessionInfo = null;
        await initSession();
      }
      return sendJSON(res, 200, { ok: true, sessions: await listSessions(), currentId: sessionInfo?.id ?? null });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 当前会话历史消息 ----
  if (req.method === 'GET' && p === '/api/sessions/messages') {
    try {
      await initSession();
      return sendJSON(res, 200, { id: sessionInfo.id, name: sessionInfo.name, messages: extractMessages() });
    } catch (e) { return sendJSON(res, 500, { error: String(e?.message ?? e) }); }
  }

  // ---- 健康检查（极简，不触发会话初始化）----
  if (req.method === 'GET' && p === '/api/health') {
    return sendJSON(res, 200, { ok: true, piVersion: SDK_VERSION });
  }

  // ---- 服务器信息 ----
  if (req.method === 'GET' && p === '/api/info') {
    try { await initSession(); } catch {}
    return sendJSON(res, 200, {
      cwd: CWD, busy, port: PORT, piVersion: SDK_VERSION,
      model: session?.state?.model?.id ?? null,
      thinkingLevel: session?.state?.thinkingLevel ?? null,
      thinkingLevels: session?.getAvailableThinkingLevels?.() ?? [],
    });
  }

  // ---- 静态文件 ----
  let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[pi-web] server started: http://localhost:${PORT}`);
  console.log(`[pi-web] cwd: ${CWD}`);
  // 预热：异步初始化会话（模型/思考 API 秒回，不用等首次请求）
  setTimeout(() => { try { initSession(); } catch {} }, 1500);
});
