// SPDX-License-Identifier: GPL-3.0-only
// Derived from ClaudiaGardner/maibot-qq-voice-call (GPL-3.0-only).
"use strict";

const { timingSafeEqual, createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences } = require("electron");
const { createVideoOutputWindow } = require('./output-window.cjs');

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const PROFILES = require('./profiles.cjs');
const { nativeProcessIds, createNativeHealth, isNativePlugin } = require('./native-health.cjs');
const ALLOWED_COMMANDS = new Set(process.platform === 'linux' ? [1, 5, 55] : [1, 55]);
const invocations = new Map();
const requestByNativeId = new Map();
const bootId = randomUUID();
const KERNEL_OUTPUTS = new Set([55, 20000, 20001, 20002, 120003]);
let bridgeInitialized = false, startupKernelBytes = 0;
const startupKernelOutputs = [];

function port(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return parsed;
}

function loadSettings(env = process.env) {
  const bridgeDir = path.resolve(env.KOISHI_RTC_QQ_BRIDGE_DIR || path.join(__dirname, ".."));
  const qqDir = path.resolve(env.KOISHI_RTC_QQ_QQ_DIR || path.join(bridgeDir, "QQ"));
  const host = env.KOISHI_RTC_QQ_AV_HOST_HOST || "127.0.0.1";
  const bridgeHost = env.KOISHI_RTC_QQ_BRIDGE_HOST || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) || !LOOPBACK_HOSTS.has(bridgeHost)) {
    throw new Error("AV host endpoints must use loopback addresses");
  }
  return {
    bridgeDir,
    qqDir,
    host,
    listenPort: port(env.KOISHI_RTC_QQ_AV_HOST_PORT, 6111, "AV host port"),
    bridgeHost,
    bridgePort: port(env.KOISHI_RTC_QQ_BRIDGE_PORT, 6110, "bridge port"),
    token: (env.KOISHI_RTC_QQ_BRIDGE_TOKEN || "").trim(),
    tokenFile: path.resolve(
      env.KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE || path.join(bridgeDir, "runtime", "control.token"),
    ),
    avsdkPath: path.resolve(
      env.KOISHI_RTC_QQ_AVSDK_PATH ||
        path.join(qqDir, process.platform === 'darwin' ? 'Resources' : 'resources', 'app', 'avsdk', process.platform === 'win32' ? 'AVSDKPlugin.dll' : process.platform === 'darwin' ? 'libAVSDKPlugin.dylib' : 'libAVSDKPlugin.so'),
    ),
  };
}

const settings = loadSettings();
let nativeProfile = null;
let nativeVideoPatch = null;
let nativeLibraryPath = settings.avsdkPath;
let controlToken = null;
let avWindow = null;
let controlServer = null;
let nextInvocationId = 1;
let nextInternalId = -1;
let audioRouter = null, windowsRoute = null, audioPoll = null;
let video = null, videoTestWindow = null;
let nativeFailure = null;
let nativeHealthPoll = null, recoveryTimer = null, quitting = false;
let rendererState = {
  ready: false,
  pluginFound: false,
  methods: [],
  messageCount: 0,
  forwardedCount: 0,
  lastForwardedCommand: null,
  forwardError: null,
  invocationCount: 0,
  lastInvocationCommand: null,
  lastInvocationAt: null,
  error: null,
  nativeFailure: null,
};

function invalidateNative(kind, details = {}) {
  // A surviving DOM postMessage method is not evidence that its PPAPI process
  // survived. This latch can only be cleared by explicitly restarting this Host.
  if (!nativeFailure) nativeFailure = { kind, at: new Date().toISOString(),
    reason: typeof details.reason === 'string' ? details.reason.slice(0, 100) : 'unknown',
    exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null };
  rendererState = { ...rendererState, ready: false, pluginFound: false,
    nativeFailure, error: `Native process unavailable (${kind}); restart the AV Host` };
  audioRouter?.stop(); windowsRoute?.close(); clearInterval(audioPoll); audioPoll = null;
  if (video) { video.enabled = false; void video.clear().catch(error => console.error(`[KoishiRTCQQAVHost] media cleanup: ${error.message}`)); }
  // Only our supervised, isolated AV Host may exit for automatic recovery.
  // The NapCat account process stays logged in; its controller reconciles the
  // old room only after it sees the replacement Host's distinct boot ID.
  if (!quitting && !recoveryTimer && process.env.KOISHI_RTC_QQ_AV_HOST_SUPERVISED === '1') {
    console.error(`[KoishiRTCQQAVHost] ${kind}: ${nativeFailure.reason}; restarting isolated media Host`);
    recoveryTimer = setTimeout(() => { recoveryTimer = null; app.quit(); }, 1000);
    recoveryTimer.unref?.();
  }
}

function loadControlToken() {
  const token = settings.token || fs.readFileSync(settings.tokenFile, "utf8").trim();
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("bridge token is missing or shorter than 32 bytes");
  }
  return token;
}

function hasValidControlToken(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(controlToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(res, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.byteLength,
    "Cache-Control": "no-store",
  });
  res.end(encoded);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function startControlServer() {
  controlServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${settings.host === '::1' ? '[::1]' : settings.host}:${settings.listenPort}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }
    if (!hasValidControlToken(req)) {
      return sendJson(res, 401, { code: -1, message: "Unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/v1/status") {
      return sendJson(res, 200, {
        code: 0,
        data: {
          electron: process.versions.electron ?? null,
          chrome: process.versions.chrome ?? null,
          bootId,
          bufferedKernelOutputs: startupKernelOutputs.length,
          nativeProfile,
          nativeVideoPatch,
          audioRouting: audioRouter?.status() ?? windowsRoute?.status() ?? { required: false, ready: null },
          routeReady: audioRouter?.status().ready ?? windowsRoute?.status().ready ?? null,
          video: video?.state() ?? { supported: false },
          ...rendererState,
        },
      });
    }
    if (url.pathname.startsWith('/v1/video/')) {
      let videoRequestBody;
      try {
        if (!video?.enabled || nativeFailure) throw new Error('Video is unavailable for this native Host');
        const operation = url.pathname.slice('/v1/video/'.length);
        let data;
        if (req.method === 'POST' && operation === 'reload' && process.env.KOISHI_RTC_QQ_VIDEO_DEV_RELOAD === '1') {
          if (video.pending.size || Object.values(video.sending).some(value => ['starting', 'sending', 'stopping'].includes(value.state))) throw new Error('Stop video sending before reloading the development module');
          delete require.cache[require.resolve('./video.cjs')];
          Object.setPrototypeOf(video, require('./video.cjs').VideoHost.prototype);
          return sendJson(res, 200, { code: 0, data: { reloaded: true } });
        }
        if (req.method === 'GET' && operation === 'state') data = video.state();
        else if (req.method === 'GET' && operation === 'sources') data = await video.sources({ callId: url.searchParams.get('callId') });
        else if (req.method === 'GET' && operation === 'frame') data = await video.frame({ callId: url.searchParams.get('callId'), trackId: url.searchParams.get('trackId') });
        else if (req.method === 'POST' && operation === 'write') data = await video.write(await readJsonBody(req, 384 * 1024));
        else if (req.method === 'POST' && operation === 'send') { videoRequestBody = await readJsonBody(req, 64 * 1024); data = await video.startSend(videoRequestBody); }
        else if (req.method === 'POST' && operation === 'stop') data = await video.stopSend(await readJsonBody(req, 64 * 1024));
        else if (req.method === 'POST' && ['session', 'subscribe', 'unsubscribe'].includes(operation)) data = await video[operation](await readJsonBody(req, 64 * 1024));
        else return sendJson(res, 404, { code: -1, message: 'Unknown video operation' });
        return sendJson(res, 200, { code: 0, data });
      } catch (error) {
        const proof = error.videoSendFailure, expected = videoRequestBody;
        const verified = proof && expected && typeof proof.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(proof.requestId) && proof.requestId === expected.requestId &&
          typeof proof.callId === 'string' && proof.callId.length <= 1024 && proof.callId === expected.callId && ['camera', 'screen'].includes(proof.kind) && proof.kind === expected.kind &&
          typeof proof.sourceId === 'string' && proof.sourceId.length <= 2048 && proof.sourceId === expected.sourceId && ['unchanged', 'stopped'].includes(proof.outcome);
        return sendJson(res, 409, { code: -1, message: error.message, errorCode: error.code,
          ...(verified ? { videoSendFailure: { requestId: proof.requestId, callId: proof.callId, kind: proof.kind, sourceId: proof.sourceId, outcome: proof.outcome } } : {}) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/audio/devices' && windowsRoute) {
      try { return sendJson(res, 200, { code: 0, data: await windowsRoute.devices() }); }
      catch (error) { return sendJson(res, 503, { code: -1, message: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/audio/route' && windowsRoute) {
      try { return sendJson(res, 200, { code: 0, data: await windowsRoute.configure(await readJsonBody(req)) }); }
      catch (error) { return sendJson(res, 409, { code: -1, message: error.message }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/invoke") {
      try {
        const body = await readJsonBody(req);
        const command = Number(body?.command);
        const params = body?.params;
        const requestId = body?.requestId;
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
          return sendJson(res, 400, { code: -1, message: 'invalid requestId' });
        }
        if (!ALLOWED_COMMANDS.has(command)) {
          return sendJson(res, 400, { code: -1, message: "command is not allowed" });
        }
        if (!Array.isArray(params) || params.length > 16) {
          return sendJson(res, 400, { code: -1, message: "invalid params" });
        }
        if (!avWindow || !rendererState.ready || !rendererState.pluginFound || !rendererState.methods.includes('postMessage')) {
          return sendJson(res, 503, { code: -1, message: 'native AVSDK is not ready' });
        }
        const fingerprint = JSON.stringify([command, params]);
        const existing = invocations.get(requestId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) return sendJson(res, 409, { code: -1, message: 'requestId conflict' });
          if (existing.result) return sendJson(res, 200, { code: 0, data: existing.result });
          return sendJson(res, 409, { code: -1, message: 'previous submission pending or unknown; not repeated' });
        }
        // Reserve before any asynchronous route check so concurrent identical
        // requests cannot both pass preflight and submit a native command.
        if (invocations.size >= 100000) return sendJson(res, 503, { code: -1, message: 'invocation capacity reached; drain calls before restarting' });
        invocations.set(requestId, { fingerprint, result: null });
        // Routing only gates controls which open microphone/playback. Login,
        // signalling and closing calls remain available even before routes exist.
        try {
          audioRouter?.assertCommandAllowed(command);
          if (windowsRoute && [4, 5].includes(command)) await windowsRoute.ensure();
        } catch (error) {
          invocations.delete(requestId); // No call command was submitted.
          return sendJson(res, 503, { code: -1, message: error.message });
        }
        if (nativeFailure || !rendererState.ready || !rendererState.pluginFound) {
          invocations.delete(requestId); // Crash occurred during asynchronous preflight.
          return sendJson(res, 503, { code: -1, message: 'Native process failed; restart the AV Host' });
        }
        const invocationId = nextInvocationId++;
        // The controller has now reached this authenticated endpoint, so its
        // callback server is running. Flush only never-submitted startup Kernel
        // envelopes, once, before native Login/control. Never retry a failed POST.
        if (!bridgeInitialized) {
          bridgeInitialized = true;
          while (startupKernelOutputs.length) {
            const message = startupKernelOutputs.shift();
            if (!await forwardPluginMessage(message)) {
              invalidateNative('startup-transport-failed', { reason: 'Kernel delivery unknown' });
              throw new Error('Startup Kernel delivery is unknown; restart the Host');
            }
          }
          startupKernelBytes = 0;
        }
        requestByNativeId.set(invocationId, requestId);
        if (windowsRoute && [4, 5].includes(command)) windowsRoute.setCallActive(true);
        const result = await avWindow?.webContents.executeJavaScript(
          `window.koishiRTCQQAVSDKInvoke(${JSON.stringify(command)},` +
            `${JSON.stringify(invocationId)},${JSON.stringify(params)})`,
          true,
        );
        if (result?.posted !== true || result?.id !== invocationId) throw new Error('invalid native submission receipt');
        invocations.get(requestId).result = result;
        rendererState = {
          ...rendererState,
          invocationCount: rendererState.invocationCount + 1,
          lastInvocationCommand: command,
          lastInvocationAt: new Date().toISOString(),
        };
        return sendJson(res, 200, { code: 0, data: result ?? null });
      } catch (_error) {
        return sendJson(res, 500, { code: -1, message: "AVSDK invocation failed" });
      }
    }
    return sendJson(res, 404, { code: -1, message: "Not Found" });
  });
  controlServer.on("clientError", (_error, socket) => socket.destroy());
  controlServer.listen(settings.listenPort, settings.host, () => {
    console.log(`[KoishiRTCQQAVHost] listening on ${settings.host}:${settings.listenPort}`);
  });
}

async function postInternal(command, id, params) {
  if (!avWindow || !rendererState.ready || !rendererState.pluginFound) throw new Error('Native renderer is not ready');
  const result = await avWindow.webContents.executeJavaScript(
    `window.koishiRTCQQAVSDKInvoke(${JSON.stringify(command)},${JSON.stringify(id)},${JSON.stringify(params)})`, true);
  if (result?.posted !== true || result?.id !== id) throw new Error('Native audio command submission failed');
  return result;
}
function startAudioRouting() {
  audioRouter?.start();
  if (windowsRoute && !audioPoll) {
    audioPoll = setInterval(() => {
      if (windowsRoute.status().ready) void windowsRoute.ensure().catch(() => {});
    }, 2000);
    audioPoll.unref?.();
  }
}
ipcMain.on("koishi-rtc-qq-avsdk-state", (_event, incoming) => {
  if (_event.sender !== avWindow?.webContents) return;
  if (nativeFailure) return;
  rendererState = {
    ...rendererState,
    ready: Boolean(incoming?.ready),
    pluginFound: Boolean(incoming?.pluginFound),
    methods: Array.isArray(incoming?.methods)
      ? incoming.methods.filter((item) => typeof item === "string").slice(0, 100)
      : [],
    error: typeof incoming?.error === "string" ? incoming.error.slice(0, 500) : null,
  };
  if (rendererState.ready && rendererState.pluginFound) startAudioRouting();
});
ipcMain.on('koishi-rtc-qq-avsdk-crash', (_event) => {
  if (_event.sender === avWindow?.webContents) invalidateNative('plugin-crash');
});
app.on('child-process-gone', (_event, details = {}) => {
  if (isNativePlugin(details.type)) invalidateNative('ppapi-process-gone', details);
});

ipcMain.on("koishi-rtc-qq-avsdk-message", () => {
  rendererState = { ...rendererState, messageCount: rendererState.messageCount + 1 };
});

async function forwardPluginMessage(message) {
  if (
    !message ||
    typeof message !== "object" ||
    !Number.isInteger(message.cmd) ||
    !Object.hasOwn(message, "value")
  ) {
    return false;
  }
  try {
    const response = await fetch(
      `http://${settings.bridgeHost === '::1' ? '[::1]' : settings.bridgeHost}:${settings.bridgePort}/v1/avsdk/output`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command: message.cmd,
          id: Number.isInteger(message.id) ? message.id : 0,
          requestId: requestByNativeId.get(message.id) ?? null,
          value: message.value,
        }),
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) throw new Error(`bridge returned HTTP ${response.status}`);
    rendererState = {
      ...rendererState,
      forwardedCount: rendererState.forwardedCount + 1,
      lastForwardedCommand: message.cmd,
      forwardError: null,
    };
    return true;
  } catch (error) {
    rendererState = { ...rendererState, forwardError: error?.message ?? String(error) };
    return false;
  }
}

ipcMain.on("koishi-rtc-qq-avsdk-raw-message", (_event, message) => {
  if (_event.sender !== avWindow?.webContents) return;
  void audioRouter?.onMessage(message);
  windowsRoute?.handle(message);
  video?.handle(message);
  if (windowsRoute && ([20011, 20022].includes(message?.cmd) ||
      ([4, 5].includes(message?.cmd) && Array.isArray(message.value) && Number.isInteger(message.value[0]) && message.value[0] !== 0))) {
    windowsRoute.setCallActive(false);
  }
  // Internal device responses are consumed locally; they carry no call event.
  if (message?.id < 0 || message?.cmd === 20061) return;
  if (!bridgeInitialized && KERNEL_OUTPUTS.has(message?.cmd)) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (startupKernelOutputs.length >= 32 || startupKernelBytes + bytes > 1024 * 1024) {
      invalidateNative('startup-transport-overflow'); return;
    }
    startupKernelOutputs.push(message); startupKernelBytes += bytes;
    return;
  }
  void forwardPluginMessage(message);
});

if (!fs.existsSync(settings.avsdkPath)) {
  throw new Error(`QQ AVSDK library was not found: ${settings.avsdkPath}`);
}
// Only enable decoded callbacks for the exact audited library/build/architecture.
try {
  const qqPackage = JSON.parse(fs.readFileSync(path.join(settings.qqDir, process.platform === 'darwin' ? 'Resources' : 'resources', 'app', 'package.json'), 'utf8'));
  const librarySHA256 = createHash('sha256').update(fs.readFileSync(settings.avsdkPath)).digest('hex');
  nativeProfile = PROFILES.find(p => p.platform === process.platform && p.arch === process.arch &&
    p.qqVersion === qqPackage.version && p.librarySHA256 === librarySHA256) ?? null;
  if (nativeProfile) for (const command of [4, 5, 8, 9, 10, 13]) ALLOWED_COMMANDS.add(command);
  if (nativeProfile?.roomIdleQuery) ALLOWED_COMMANDS.add(14);
  if (nativeProfile?.platform === 'linux') ALLOWED_COMMANDS.add(57);
  if (nativeProfile?.privateScreen) ALLOWED_COMMANDS.add(43);
} catch { /* Unknown profiles keep the upstream-only command/observation boundary. */ }
if (nativeProfile) {
  // Patch only a generated copy after exact profile verification. Any patch
  // integrity failure aborts startup instead of loading a partially edited SDK.
  const { prepareNativeVideoLibrary } = require('./native-shader-patch.cjs');
  const prepared = prepareNativeVideoLibrary({ originalPath: settings.avsdkPath,
    cacheRoot: path.join(settings.bridgeDir, 'runtime', 'native-video'), profile: nativeProfile });
  nativeLibraryPath = prepared.path; nativeVideoPatch = prepared.patch;
}
if (nativeProfile && process.platform === 'darwin') {
  const { createMacAudioRouter } = require('../macos/audio-route.cjs');
  audioRouter = createMacAudioRouter({ send: (command, params) => postInternal(command, nextInternalId--, params),
    onFatal: () => { rendererState.ready = false; app.quit(); } });
}
if (nativeProfile && process.platform === 'win32') {
  const { AudioRouteGuard } = require('../windows/route-guard.cjs');
  windowsRoute = new AudioRouteGuard({ post: postInternal,
    fatal: () => { rendererState.ready = false; app.quit(); } });
}
controlToken = loadControlToken();
app.commandLine.appendSwitch(
  "register-pepper-plugins",
  `${nativeLibraryPath};application/x-ppapi-avSDK`,
);
if (process.platform === 'win32') app.commandLine.appendSwitch('allow-command-line-plugins');
app.commandLine.appendSwitch("disable-gpu");
// Native layout command 54 uses physical rectangles with a 100% scale. Keep
// this isolated host at 1x even on a HiDPI desktop; other applications retain
// their own display scale.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch("no-sandbox");
app.setPath("userData", path.join(settings.bridgeDir, "runtime", "av-host-profile"));

app.whenReady()
  .then(async () => {
    avWindow = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        plugins: true,
        sandbox: false,
        backgroundThrottling: false,
        zoomFactor: 1,
      },
    });
    avWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    avWindow.webContents.on('will-navigate', event => event.preventDefault());
    avWindow.webContents.on("render-process-gone", (_event, details) => {
      invalidateNative('renderer-process-gone', details);
    });
    await avWindow.loadFile(path.join(__dirname, "host.html"));
    const nativeHealth = createNativeHealth({
      read: () => nativeProcessIds({ app, fs, platform: process.platform, pid: process.pid }),
      onGone: invalidateNative,
    });
    nativeHealth.check();
    nativeHealthPoll = setInterval(() => nativeHealth.check(), 1000);
    nativeHealthPoll.unref?.();
    const { VideoHost } = require('./video.cjs');
    const { DesktopVideo, ownedWindowHandle } = require('./desktop-video.cjs');
    const desktopVideo = new DesktopVideo({ BrowserWindow, desktopCapturer, systemPreferences });
    video = new VideoHost({
      enabled: nativeProfile?.video === true,
      send: (command, params, id) => postInternal(command, id ?? nextInternalId--, params),
      listWindows: () => desktopVideo.sources(),
      captureSource: (source, onFailure) => desktopVideo.open(source, onFailure),
      closeCapture: () => desktopVideo.close(),
      ensurePermission: kind => desktopVideo.ensure(kind),
      permissions: () => desktopVideo.status(),
      testWindow: async () => {
        if (!videoTestWindow || videoTestWindow.isDestroyed()) {
          videoTestWindow = createVideoOutputWindow(BrowserWindow, { title: 'Koishi RTC · Video Test' });
          videoTestWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          await videoTestWindow.loadFile(path.join(__dirname, 'video-test.html'));
          videoTestWindow.showInactive();
        }
        return ownedWindowHandle(videoTestWindow);
      },
      closeTestWindow: () => { if (videoTestWindow && !videoTestWindow.isDestroyed()) videoTestWindow.destroy(); videoTestWindow = null; },
      surface: async (width, height) => {
        const [currentWidth, currentHeight] = avWindow.getContentSize();
        if (currentWidth !== width || currentHeight !== height) avWindow.setContentSize(width, height);
        avWindow.showInactive();
        await avWindow.webContents.executeJavaScript(`window.koishiRTCQQVideoSurface(${width},${height})`);
      },
      present: (width, height) => avWindow.webContents.executeJavaScript(`window.koishiRTCQQVideoPresent(${width},${height})`),
      capture: () => avWindow.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true }),
    });
    startControlServer();
  })
  .catch((error) => {
    console.error(`[KoishiRTCQQAVHost] startup failed: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });

app.on('before-quit', () => {
  quitting = true;
  clearInterval(nativeHealthPoll); clearTimeout(recoveryTimer);
  if (video) { video.enabled = false; void video.clear().catch(error => console.error(`[KoishiRTCQQAVHost] media cleanup: ${error.message}`)); }
  audioRouter?.stop(); windowsRoute?.close(); clearInterval(audioPoll);
  controlServer?.close();
});
app.on("window-all-closed", () => app.quit());
