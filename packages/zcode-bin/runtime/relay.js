#!/usr/bin/env node
// zcode-headless-relay: 让 headless 后端在 z.ai relay 上以"桌面设备"身份注册,
// 手机端(zcode.z.ai/remote/v4 / Android app)即可完成配对,不再卡"等待桌面端"。
//
// 桌面设备侧握手(逆向自 desktop app.asar out/main/index.js):
//   ws connect wss://zcode.z.ai/ws?mid={deviceMid}
//   → device_register_init {device_mid, pass_hash, meta}      (首次,无 deviceSid 时)
//   ← device_register_ack {device_sid}                        (持久化 sid)
//   → auth_init {role:'device', device_sid}
//   ← auth_challenge {nonce}
//   → auth_response {device_sid, proof=base64url(HMAC_SHA256(key=passHash, `${nonce}|device|${sid}`))}
//   ← auth_ack {pair_status: waiting|matched}
//   心跳: pair_status_query → pair_status_ack (10s + 抖动, 30s watchdog)
//
// 配对成功后处理 L2 控制面: bootstrap / workspace-list / workspace-bridge-open,
// L4 (rpc-frame → VS Code IPC) 桥接到本地 app-server (ZCode Protocol stdio) 的最小子集:
//   zcode-agent.helloConversationV4 / initializeConversationV4 / subscribeConversationV4 /
//   sendConversationCommandV4(sendText/stop/resolveInteraction) → session/* RPC。
//
// 凭证来源(与桌面端共享,自动读取):
//   deviceMid  ~/.zcode/v2/telemetry-state.json
//   deviceSid  ~/.zcode/v2/setting.json (.webRemoteControlExternalRelayDevice.deviceSid)
//   passHash   ~/.zcode/v2/credentials.json "web-remote-control:external-relay:pass_hash"
//              (enc:v1, AES-256-GCM, key=sha256("zcode-credential-fallback:linux:$HOME:$USER"))
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOME = os.homedir();
const V2 = path.join(HOME, '.zcode', 'v2');
const RELAY = process.env.ZCODE_RELAY_URL || 'wss://zcode.z.ai/ws';
const WORKSPACE = process.env.ZCODE_HEADLESS_WORKSPACE || process.cwd();
const CLI = process.env.ZCODE_CLI_PATH || '/usr/lib/zcode/glm/zcode.cjs';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[relay]', ...a);

// ---------- 凭证加载 ----------
function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function decryptEncV1(body) {
  const secret = `zcode-credential-fallback:linux:${HOME}:${os.userInfo().username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  const [a, c, m] = body.slice('enc:v1:'.length).split('.');
  const iv = Buffer.from(a, 'base64url'), tag = Buffer.from(c, 'base64url'), ct = Buffer.from(m, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function loadCreds() {
  const deviceMid = loadJson(path.join(V2, 'telemetry-state.json')).deviceMid;
  const settings = loadJson(path.join(V2, 'setting.json'));
  const deviceSid = settings.webRemoteControlExternalRelayDevice?.deviceSid;
  const creds = loadJson(path.join(V2, 'credentials.json'));
  const enc = creds['web-remote-control:external-relay:pass_hash'];
  const passHash = enc ? (enc.startsWith('enc:v1:') ? decryptEncV1(enc) : enc) : undefined;
  if (!deviceMid || !passHash) throw new Error('缺少 deviceMid 或 passHash;请先运行一次桌面端完成注册');
  return { deviceMid, deviceSid, passHash };
}
const proof = (passHash, nonce, role, sid) =>
  crypto.createHmac('sha256', passHash).update(`${nonce}|${role}|${sid}`).digest('base64url');
const crc32hex = (buf) => {
  let c, table = crc32hex.table;
  if (!table) { table = crc32hex.table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
};

// ---------- 本地 app-server(每会话一个 stdio 子进程) ----------
class AppServer {
  constructor(workspace) {
    this.workspace = workspace;
    this.child = spawn(process.env.ZCODE_NODE_PATH || process.execPath, [CLI, 'app-server', '--stdio'], { cwd: workspace });
    this.waiters = new Map(); this.nextId = 1; this.buf = ''; this.closed = false;
    this.events = [];            // 未消费的事件(method 帧)
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => { if (process.env.ZCODE_RELAY_DEBUG) log('app-server:', d.toString().trim()); });
    this.child.on('error', (e) => this._fail(e));
    this.child.on('exit', (code, signal) => this._fail(new Error(`app-server exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`)));
  }
  _fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiter] of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
  _respond(id, result, error) {
    if (id == null || this.closed || !this.child.stdin.writable) return;
    const message = error ? { id, error: { code: error.code ?? -32603, message: error.message } } : { id, result };
    try { this.child.stdin.write(JSON.stringify(message) + '\n'); } catch (e) { this._fail(e); }
  }
  _onRequest(m) {
    // session/create materializes an app and asks its client for these settings.
    // Headless has no UI, so use the same defaults as the desktop client.
    if (m.method === 'session/requestRuntimePreferences') {
      this._respond(m.id, {
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      });
      return;
    }
    this._respond(m.id, null, Object.assign(new Error(`unsupported app-server request: ${m.method}`), { code: -32601 }));
  }
  _onData(d) {
    this.buf += d.toString();
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && this.waiters.has(m.id)) {
        const waiter = this.waiters.get(m.id); this.waiters.delete(m.id);
        if (m.error) {
          const error = Object.assign(new Error(m.error.message || 'app-server request failed'), { code: m.error.code, data: m.error.data });
          waiter.reject(error);
        } else waiter.resolve(m);
      } else if (m.id != null && m.method) this._onRequest(m);
      else if (m.method) {
        this.events.push(m);
        if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
        this.onEvent?.(m);
      }
    }
  }
  call(method, params, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.waiters.set(id, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      try { this.child.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n'); }
      catch (e) { this.waiters.delete(id); clearTimeout(t); reject(e); }
    });
  }
  drainEvents() { const e = this.events.splice(0); return e; }
  dispose() { if (this.closed) return; this._fail(new Error('app-server disposed')); try { this.child.kill(); } catch {} }
}

// ---------- WebSocket(用 CLI 内置的 ws?CLI bundle 未导出;直接用系统 node 的 ws 包不可假设存在) ----------
// 最小 WS 客户端实现(RFC6455 文本帧),零依赖。
class WS {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const lib = u.protocol === 'ws:' ? require('http') : require('https');
      const req = lib.request({
        host: u.hostname, port: u.port || (u.protocol === 'ws:' ? 80 : 443), path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
                   Host: u.host, Origin: 'https://zcode.z.ai', 'X-Device-ID': u.searchParams.get('mid') || '' },
      });
      req.on('upgrade', (res, socket) => resolve(new WS(socket)));
      req.on('response', (r) => reject(new Error('no upgrade: ' + r.statusCode)));
      req.on('error', reject);
      req.end();
    });
  }
  constructor(socket) { this.s = socket; this.s.setNoDelay(true); this.handlers = {}; this.alive = true;
    let buf = Buffer.alloc(0);
    this.s.on('data', (d) => { buf = Buffer.concat([buf, d]); let f;
      while ((f = this._frame(buf))) { buf = f.rest; if (f.text != null) this.handlers.message?.(f.text); if (f.close) { this.alive = false; const c = f.closePayload; log('close frame code=' + (c ? c.readUInt16BE(0) : '?') + ' reason=' + (c ? c.subarray(2).toString('utf8') : '')); this.handlers.close?.(); } } });
    this.s.on('error', () => { this.alive = false; this.handlers.close?.(); });
    this.s.on('close', () => { if (this.alive) { this.alive = false; this.handlers.close?.(); } });
  }
  _frame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1]; const opcode = b0 & 0x0F; const masked = b1 & 0x80; let len = b1 & 0x7F; let off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (masked) off += 4;
    if (buf.length < off + len) return null;
    const payload = buf.subarray(off, off + len); const rest = buf.subarray(off + len);
    if (opcode === 8) return { close: true, closePayload: payload, rest };
    if (opcode === 1) return { text: payload.toString('utf8'), rest };
    if (opcode === 9) { this.s.write(this._encode(10, payload)); return { rest }; } // ping→pong
    return { rest };
  }
  _encode(opcode, payload) {
    const len = payload.length; let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[1] |= 0x80; // 客户端帧必须 mask,mask 位在 byte1
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }
  send(text) { if (this.alive) this.s.write(this._encode(1, Buffer.from(text, 'utf8'))); }
  close() { this.alive = false; try { this.s.write(this._encode(8, Buffer.alloc(0))); } catch {} this.s.end(); }
}

// ---------- 设备传输 ----------
class RelayDevice {
  constructor(creds) {
    this.creds = creds; this.state = 'idle'; this.handlers = {}; this.bridge = null;
    this.frameSeq = 0; this.msgSeq = 0; this.heartbeat = null; this.stopped = false;
    this._revision = 0; this._eventSeq = 0; this._pushTimer = null; this._rowId = 0;
  }
  on(evt, fn) { this.handlers[evt] = fn; }
  emit(evt, ...a) { this.handlers[evt]?.(...a); }
  send(obj) { if (this.ws?.alive) { this.ws.send(JSON.stringify(obj)); return true; } return false; }
  sendL2(payload) { const ok = this.send({ type: 'data', payload, client_ts: Date.now() }); log('L2 =>', payload.zcode_type, ok ? '' : '(发送失败)'); return ok; }
  async connect() {
    const ws = await WS.connect(`${RELAY}?mid=${encodeURIComponent(this.creds.deviceMid)}`);
    this.ws = ws;
    ws.handlers.message = (t) => { log('recv:', t.slice(0, 160)); this._onMessage(JSON.parse(t)); };
    ws.handlers.close = () => { if (!this.stopped) { log('连接断开,5s 后重连'); this._stopHeartbeat(); setTimeout(() => this.connect().catch(console.error), 5000); } };
    this.state = 'connecting';
    if (this.creds.deviceSid) this._authInit(this.creds.deviceSid);
    else this.send({ type: 'device_register_init', device_mid: this.creds.deviceMid, pass_hash: this.creds.passHash, meta: this._meta(), client_ts: Date.now() });
  }
  _meta() { return { platform: process.platform, version: '3.10.2', name: os.hostname() }; }
  _authInit(sid) { this.state = 'authenticating'; this.send({ type: 'auth_init', role: 'device', device_sid: sid, meta: this._meta(), client_ts: Date.now() }); }
  _onMessage(m) {
    switch (m.type) {
      case 'device_register_ack':
        this.creds.deviceSid = m.device_sid; this._persistSid(m.device_sid); writePairingUrl(this.creds); this._authInit(m.device_sid); break;
      case 'auth_challenge':
        this.send({ type: 'auth_response', device_sid: this.creds.deviceSid, proof: proof(this.creds.passHash, m.nonce, 'device', this.creds.deviceSid), client_ts: Date.now() }); break;
      case 'auth_ack': case 'pair_status_ack': {
        this.state = m.pair_status || this.state;
        if (m.type === 'pair_status_ack') { this._armWatchdog(); break; }
        log('配对状态:', this.state);
        if (this.state === 'matched' || this.state === 'paired') this.emit('paired');
        this._startHeartbeat(); break;
      }
      case 'pair_status_query':
        this.send({ type: 'pair_status_ack', pair_status: this.state === 'matched' ? 'matched' : 'waiting', client_ts: Date.now() }); break;
      case 'data': this._onL2(m.payload || {}); break;
      case 'error': log('relay 错误:', m.code, m.message || ''); break;
    }
  }
  _persistSid(sid) {
    try {
      const p = path.join(V2, 'setting.json'); const s = loadJson(p);
      s.webRemoteControlExternalRelayDevice = { deviceSid: sid };
      fs.writeFileSync(p, JSON.stringify(s, null, 2));
      log('deviceSid 已持久化:', sid);
    } catch (e) { console.error('持久化 sid 失败:', e.message); }
  }
  _startHeartbeat() { this._stopHeartbeat(); this.heartbeat = setInterval(() => { this.send({ type: 'pair_status_query', device_sid: this.creds.deviceSid, client_ts: Date.now() }); }, 10000); }
  _armWatchdog() { this.lastAck = Date.now(); if (!this._wd) this._wd = setInterval(() => { if (this.lastAck && Date.now() - this.lastAck > 30000) { log('心跳超时,重连'); this.ws?.close(); } }, 5000); }
  _stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  async _onL2(payload) {
    const t = payload.zcode_type;
    log('L2 <=', t || JSON.stringify(payload).slice(0, 80));
    if (t === 'bootstrap-request' || t === 'workspace-list-request') {
      await this.refreshTasks().catch(() => {});
      const respType = t === 'bootstrap-request' ? 'bootstrap-response' : 'workspace-list-response';
      this.sendL2({
        zcode_type: respType, requestId: payload.requestId, success: true,
        result: {
          ...(t === 'bootstrap-request' ? { windowControlSessionId: 'headless-' + process.pid } : {}),
          workspaces: [{ workspacePath: WORKSPACE, workspaceKey: WORKSPACE, label: path.basename(WORKSPACE), workspacePurpose: 'project', kind: 'local', connectionState: 'connected' }],
          tasks: this._tasks(),
          activeWorkspaceKey: WORKSPACE,
          activeTaskId: this._tasks()?.[0]?.taskId ?? null,
          ...(t === 'bootstrap-request' ? {
            initialViewState: { activeWorkspaceKey: WORKSPACE, activeTaskId: this._tasks()?.[0]?.taskId ?? null, updatedAt: Date.now() },
            mobileViewState: { activeWorkspaceKey: WORKSPACE, activeTaskId: this._tasks()?.[0]?.taskId ?? null, updatedAt: Date.now() },
          } : {}),
        },
      });
    } else if (t === 'workspace-bridge-open') {
      this._sessionServer?.dispose();
      this.bridge = { bridgeSessionId: payload.bridgeSessionId, bridgeGeneration: payload.bridgeGeneration || 0 };
      this.frameSeq = 0; this.msgSeq = 0; this._listenReqId = null; this._sessionServer = null;
      this.sendL2({ zcode_type: 'workspace-bridge-ready', requestId: payload.requestId, success: true, bridgeSessionId: payload.bridgeSessionId, bridgeGeneration: this.bridge.bridgeGeneration, bridge: { kind: 'local', workspaceKey: WORKSPACE, workspacePath: WORKSPACE } });
      log('bridge 建立:', payload.bridgeSessionId);
    } else if (t === 'workspace-reconnect-request') {
      this.sendL2({ zcode_type: 'workspace-reconnect-response', requestId: payload.requestId, success: true, workspaceKey: payload.workspaceKey });
    } else if (t === 'rpc-frame') {
      this._onRpcFrame(payload);
    }
    // mobile-view-state-update / app-error 等忽略
  }
  _tasks() {
    // 从最近会话生成 tasks(app-server session/list,可能因模型配置缺失失败 → 优雅降级)
    if (this._cachedTasks && Date.now() - this._tasksAt < 30000) return this._cachedTasks;
    return this._cachedTasks || [];
  }
  async refreshTasks() {
    try {
      const srv = this._server(); const r = await srv.call('session/list', { workspace: { workspaceKey: WORKSPACE, workspacePath: WORKSPACE } });
      this._cachedTasks = (r.result?.sessions || []).slice(0, 50).map((s) => ({
        taskId: s.sessionId, title: s.title || s.sessionId, workspacePath: WORKSPACE,
        workspaceLabel: path.basename(WORKSPACE), workspaceKind: 'local', createdAt: s.createdAt,
        updatedAt: s.updatedAt, provider: 'glm', displayStatus: s.status === 'running' ? 'running' : s.status === 'error' ? 'error' : s.status === 'completed' ? 'completed' : 'idle',
      }));
      this._tasksAt = Date.now();
    } catch {}
    return this._cachedTasks || [];
  }
  _server() {
    if (!this._sessionServer) {
      this._sessionServer = new AppServer(WORKSPACE);
      this._sessionServer.onEvent = () => this._schedulePush();
    }
    return this._sessionServer;
  }

  _sendIpc(head, data) {
    if (!this.bridge) return;
    const bytes = encTLV(head, data);
    this.msgSeq += 1; this.frameSeq += 1;
    this.sendL2({
      zcode_type: 'rpc-frame', bridgeSessionId: this.bridge.bridgeSessionId, bridgeGeneration: this.bridge.bridgeGeneration,
      seq: this.frameSeq, messageSeq: this.msgSeq, fragmentIndex: 0, fragmentCount: 1, messageBytes: bytes.length,
      checksum: { algorithm: 'crc32', value: crc32hex(bytes) }, dataBase64: bytes.toString('base64'),
    });
  }
  _onRpcFrame(payload) {
    this.sendL2({ zcode_type: 'rpc-frame-ack', bridgeSessionId: payload.bridgeSessionId, ackMessageSeq: payload.messageSeq });
    let msg; try { msg = decTLV(Buffer.from(payload.dataBase64, 'base64')); } catch (e) { console.error('TLV 解码失败:', e.message); return; }
    const [type, reqId, channel, method] = msg.head; const args = Array.isArray(msg.data) ? msg.data : [];
    if (type === 100) this._onCall(channel, method, args, reqId);
    else if (type === 102) { if (channel === 'zcode-agent' && String(method).startsWith('onDynamic')) { this._listenReqId = reqId; } }
    else if (type === 103) { if (this._listenReqId === reqId) this._listenReqId = null; }
  }
  _reply201(reqId, data) { this._sendIpc([201, reqId], data); }
  async _onCall(channel, method, args, reqId) {
    if (channel !== 'zcode-agent') { this._reply201(reqId, {}); return; }
    try {
      const srv = this._server();
      const wsArg = { workspaceKey: WORKSPACE, workspacePath: WORKSPACE };
      if (method === 'helloConversationV4') this._reply201(reqId, { kind: 'hello', protocolVersion: 3, clientMode: 'web-remote-replayable' });
      else if (method === 'initializeConversationV4') this._reply201(reqId, null);
      else if (method === 'subscribeConversationV4') {
        const sid = args[0]?.sessionId; this._activeSession = sid || this._activeSession;
        this._subscriptionId = `relay-${process.pid}-${this._activeSession || 'workspace'}`;
        this._eventSeq = 0;
        this._reply201(reqId, { ack: { subscriptionId: this._subscriptionId, mode: 'snapshot', logEpoch: 'relay' } });
        await this.refreshTasks();
        this._pushEvents(srv);
      } else if (method === 'sendConversationCommandV4') {
        const command = args[0] || {};
        const env = command.envelope || command;
        const commandId = env.commandId || crypto.randomUUID();
        const ack = (status, result, extra = {}) => this._reply201(reqId, {
          commandId, status, revisionAtDecision: this._revision,
          ...(result ? { result } : {}), ...extra,
        });
        if (env.type === 'createSession') {
          const r = await srv.call('session/create', { workspace: wsArg }, 20000);
          const rr = r.result || {}; const sess = rr.session?.sessionId || rr.sessionId;
          if (!sess) throw new Error('session/create returned no sessionId');
          this._activeSession = sess;
          this._revision = rr.session?.stateRevision ?? rr.stateRevision ?? this._revision;
          const firstText = env.payload?.firstInput?.text;
          let input;
          if (typeof firstText === 'string') {
            const sent = await srv.call('session/send', { sessionId: sess, inputId: commandId, queryId: commandId, content: firstText }, 20000);
            this._revision = sent.result?.stateRevision ?? this._revision;
            input = { delivery: 'startNow', inputId: commandId, ...(sent.result?.messageId ? { messageId: sent.result.messageId } : {}) };
          }
          ack('accepted', { type: 'createSession', sessionId: sess, ...(input ? { input } : {}) });
        } else if (env.type === 'sendText') {
          const sessionId = env.sessionId || this._activeSession;
          if (!sessionId) throw new Error('sendText requires a sessionId; subscribe or create a session first');
          const text = env.payload?.text ?? env.content ?? '';
          const inputId = env.inputId || commandId;
          const sent = await srv.call('session/send', {
            sessionId, inputId, queryId: env.queryId || inputId, content: text,
            ...(env.baseRevision !== undefined ? { expectedRevision: env.baseRevision } : {}),
          }, 20000);
          this._activeSession = sessionId;
          this._revision = sent.result?.stateRevision ?? this._revision;
          ack('accepted', { type: 'inputAccepted', delivery: env.payload?.requestedDelivery || 'startNow', inputId, ...(sent.result?.messageId ? { messageId: sent.result.messageId } : {}) });
          this._pushEvents(srv);
        } else if (env.type === 'stop') {
          const sessionId = env.sessionId || this._activeSession;
          if (sessionId) await srv.call('session/stop', { sessionId }).catch(() => {});
          ack('accepted');
        } else if (env.type === 'resolveInteraction') {
          // Interaction resolution is currently handled by the mobile UI. Keep
          // the command idempotent so the client can continue its conversation.
          ack('accepted', { type: 'resolveInteraction', resolvedBy: { clientId: env.clientId || 'headless-relay' } });
        } else ack('rejected', undefined, { reasonCode: 'unsupported_command', message: `Unsupported conversation command: ${env.type}` });
      } else this._reply201(reqId, {});
    } catch (e) {
      console.error('L4 call 失败:', e.message);
      this._sendIpc([202, reqId], { code: e.code, message: e.message });
    }
  }
  _schedulePush() {
    if (this._pushTimer || !this._listenReqId) return;
    this._pushTimer = setTimeout(() => { this._pushTimer = null; this._pushEvents(this._sessionServer); }, 50);
  }
  _pushEvents(srv) {
    if (!srv) return;
    // 把 app-server 事件帧转成 conversation snapshot 推给手机(最小渲染协议)
    if (!this._listenReqId) return;
    const events = srv.drainEvents();
    const rows = events.filter((e) => e.method === 'session/event' || e.method === 'state.updated').map((e, i) => ({
      rowId: ++this._rowId, turnId: e.params?.turnId || 'relay', kind: 'assistantText', text: this._eventText(e),
      state: 'complete', visibility: 'visible', createdAt: Date.now(), createdAtSeq: this._eventSeq + i + 1,
    }));
    if (!rows.length) return;
    const fromSeq = this._eventSeq + 1; this._eventSeq += rows.length;
    this._sendIpc([204, this._listenReqId], {
      topic: `conversation/${this._activeSession}`, subscriptionId: this._subscriptionId || `relay-${process.pid}`,
      logEpoch: 'relay', fromSeq, toSeq: this._eventSeq, sentAt: Date.now(),
      payload: { kind: 'snapshot', snapshot: this._snapshot(rows) },
    });
  }
  _snapshot(rows) {
    const allowed = { allowed: true };
    return {
      protocolVersion: 1, sessionId: this._activeSession, logEpoch: 'relay', seq: this._eventSeq,
      revision: this._revision,
      control: { phase: 'running', sessionEnded: false, canStop: true, stopState: 'stoppable', stopTargetKind: 'assistant', activeWorks: [], lastError: null, apiRetry: null },
      availability: { fork: allowed, compact: allowed, switchModelConfig: allowed, setFollowupMode: allowed, queueEdit: allowed, sendQueuedNow: allowed, pauseGoal: allowed, resumeGoal: allowed },
      inputRouting: { mode: 'startNow' },
      meta: { title: '', titleSource: 'default' },
      config: { provider: 'glm', model: 'unknown', thought: 'default', thoughtLevels: [], followupMode: 'queue', mode: 'build' },
      modelTransition: null,
      usage: { contextWindow: null, cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      queue: { items: [], autoDrain: true }, pendingInteractions: [], pendingCommands: [], backgroundWorks: [], goal: null, plan: null,
      workspaceHookAdmission: null,
      rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    };
  }
  _eventText(event) {
    const p = event?.params || {};
    const candidates = [p.text, p.content, p.message?.content, p.event?.text, p.event?.content];
    const text = candidates.find((value) => typeof value === 'string' && value.length > 0);
    return (text || JSON.stringify(p)).slice(0, 2000);
  }
  stop() { this.stopped = true; this._stopHeartbeat(); if (this._wd) { clearInterval(this._wd); this._wd = null; } if (this._pushTimer) clearTimeout(this._pushTimer); this._pushTimer = null; this.ws?.close(); this._sessionServer?.dispose(); }
}

// ---------- 最小 TLV(与 app TlvCodec/官方序列化器一致) ----------
function varint(n) { const o = []; if (n === 0) o.push(0); let x = n; while (x > 0) { let b = x & 0x7F; x = Math.floor(x / 128); if (x > 0) b |= 0x80; o.push(b); } return o; }
function encValue(v) {
  if (v === undefined || v === null) return [0];
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return [1, ...varint(b.length), ...b]; }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return [6, ...varint(v)];
  if (typeof v === 'boolean') return [v ? 7 : 8];
  if (Buffer.isBuffer(v)) return [2, ...varint(v.length), ...v];
  if (Array.isArray(v)) { const o = [4, ...varint(v.length)]; for (const e of v) o.push(...encValue(e)); return o; }
  const b = Buffer.from(JSON.stringify(v), 'utf8'); return [5, ...varint(b.length), ...b];
}
function encTLV(head, data) { return Buffer.from([...encValue(head), ...encValue(data)]); }
class R { constructor(b) { this.b = b; this.p = 0; } byte() { return this.p < this.b.length ? this.b[this.p++] : -1; }
  varint() { let r = 0, s = 0; for (;;) { const b = this.byte(); r += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) return r; s += 7; } }
  bytes(n) { const o = this.b.subarray(this.p, this.p + n); this.p += n; return o; }
  value() { const t = this.byte(); switch (t) {
    case 0: return null; case 1: return Buffer.from(this.bytes(this.varint())).toString('utf8');
    case 2: case 3: return Buffer.from(this.bytes(this.varint()));
    case 4: { const n = this.varint(); const a = []; for (let i = 0; i < n; i++) a.push(this.value()); return a; }
    case 5: try { return JSON.parse(Buffer.from(this.bytes(this.varint())).toString('utf8')); } catch { return {}; }
    case 6: return this.varint(); case 7: return true; case 8: return false;
    default: throw new Error('bad tag ' + t); } } }
function decTLV(buf) { const r = new R(buf); return { head: r.value(), data: r.value() }; }

// ---------- main ----------
function writePairingUrl(creds) {
  try {
    const url = new URL('https://zcode.z.ai/remote/v4');
    url.searchParams.set('sid', creds.deviceSid);
    url.searchParams.set('hash', creds.passHash);
    url.searchParams.set('t', String(Date.now()));
    url.searchParams.set('mid', creds.deviceMid);
    url.searchParams.set('name', os.hostname());
    url.searchParams.set('app_version', '3.10.2');
    const out = path.join(HOME, '.zcode', 'remote-pairing-url.txt');
    fs.writeFileSync(out, url.toString());
    log('配对 URL 已更新 → ' + out + ' (浏览器/手机打开即连)');
  } catch (e) { console.error('写配对 URL 失败:', e.message); }
}
async function main() {
  const creds = loadCreds();
  log('凭证加载 OK: mid=' + creds.deviceMid + ' sid=' + (creds.deviceSid || '(未注册,将自动注册)'));
  const dev = new RelayDevice(creds);
  dev.on('paired', () => { log('★ 终端已配对 matched,可以远程操作了'); dev.refreshTasks(); });
  await dev.connect();
  log('已连接 relay,等待终端(浏览器/手机)配对…');
  writePairingUrl(creds);
  process.on('SIGUSR1', () => writePairingUrl(creds));
}

if (require.main === module) main().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });

module.exports = { AppServer, RelayDevice, WS, crc32hex, decTLV, encTLV, loadCreds, main };
