// SPDX-License-Identifier: GPL-3.0-only
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, PROTOCOL_VERSION } from './controller.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export function parseSettings(env = process.env, pluginDir = '.') {
  const configFile = path.join(pluginDir, 'bridge-config.json');
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  // Names are explicit to preserve the documented environment variables.
  const controlHost = env.KOISHI_RTC_QQ_BRIDGE_HOST ?? config.controlHost ?? '127.0.0.1';
  const avHost = env.KOISHI_RTC_QQ_AV_HOST_HOST ?? config.avHost ?? '127.0.0.1';
  if (!LOOPBACK.has(controlHost) || !LOOPBACK.has(avHost)) throw new Error('Bridge and AV Host must listen on loopback');
  const port = (input, fallback) => {
    const result = input === undefined ? fallback : Number(input);
    if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid bridge port');
    return result;
  };
  const mediaValue = env.KOISHI_RTC_QQ_MEDIA_ENABLED ?? config.mediaEnabled ?? false;
  if (![true, false, 'true', 'false', '1', '0'].includes(mediaValue)) throw new Error('Invalid mediaEnabled setting');
  return { controlHost, avHost,
    controlPort: port(env.KOISHI_RTC_QQ_BRIDGE_PORT ?? config.controlPort, 6110),
    avPort: port(env.KOISHI_RTC_QQ_AV_HOST_PORT ?? config.avPort, 6111),
    mediaEnabled: [true, 'true', '1'].includes(mediaValue),
    token: (env.KOISHI_RTC_QQ_BRIDGE_TOKEN ?? '').trim(),
    tokenFile: env.KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE ?? config.tokenFile ?? '',
  };
}
export function loadToken(settings) {
  const token = settings.token || fs.readFileSync(settings.tokenFile, 'utf8').trim();
  if (Buffer.byteLength(token) < 32) throw new Error('Bridge token must contain at least 32 bytes');
  return token;
}
export function authorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)), expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new BridgeError('BODY_TOO_LARGE', 'Request body exceeds limit', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('INVALID_JSON', 'Expected a JSON request body'); }
}
export function createHttpServer(controller, token) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (!authorized(req, token)) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
      let data;
      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/v1/capabilities': data = await controller.probe(); break;
          case '/v1/status': data = controller.status(); break;
          case '/v1/calls/current': data = controller.current(); break;
          case '/v1/groups/current': data = controller.group(); break;
          case '/v1/video/state': data = await controller.video('state'); break;
          case '/v1/video/sources': data = await controller.video('sources', Object.fromEntries(url.searchParams)); break;
          case '/v1/video/frame': data = await controller.video('frame', Object.fromEntries(url.searchParams)); break;
          case '/v1/events': {
            const raw = url.searchParams.get('after') ?? '0';
            if (!/^\d+$/.test(raw)) throw new BridgeError('INVALID_CURSOR', 'after must be a nonnegative integer');
            data = controller.getEvents(Number(raw), url.searchParams.get('bootId')); break;
          }
          default: throw new BridgeError('NOT_FOUND', 'Unknown endpoint', 404);
        }
      } else if (req.method === 'POST') {
        const body = await readBody(req);
        if (/^\/v1\/video\/(session|subscribe|unsubscribe|send|stop|write)$/.test(url.pathname)) {
          data = await controller.video(url.pathname.split('/').at(-1), body);
        } else if (url.pathname === '/v1/avsdk/output') {
          await controller.nativeOutput(body); data = { received: true };
        } else {
          const operations = { '/v1/calls/accept': 'accept', '/v1/calls/reject': 'reject',
            '/v1/calls/dial': 'dial', '/v1/calls/hangup': 'hangup',
            '/v1/groups/join': 'group.join', '/v1/groups/start': 'group.start', '/v1/groups/leave': 'group.leave' };
          const operation = operations[url.pathname];
          if (!operation) throw new BridgeError('NOT_FOUND', 'Unknown endpoint', 404);
          data = await controller.control(operation, body);
        }
      } else throw new BridgeError('METHOD_NOT_ALLOWED', 'Unsupported HTTP method', 405);
      return send(res, data?.status === 'submitted' || data?.status === 'unknown' ? 202 : 200,
        { ok: true, protocolVersion: PROTOCOL_VERSION, data });
    } catch (error) {
      const known = error instanceof BridgeError;
      return send(res, known ? error.status : 500, { ok: false, error: {
        code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Internal bridge error',
        ...(known && error.capability ? { capability: error.capability } : {}),
      } });
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

export function createHostTransport(settings, token) {
  const hostname = settings.avHost === '::1' ? '[::1]' : settings.avHost;
  const base = `http://${hostname}:${settings.avPort}`;
  const safeMessage = message => (typeof message === 'string' ? message : 'AV Host rejected request')
    .split(token).join('[redacted]')
    .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  async function request(route, body) {
    let response, json;
    try {
      response = await fetch(base + route, { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(route.startsWith('/v1/video/') ? 15_000 : 3000) });
      try { json = await response.json(); } catch { /* Never forward an arbitrary HTML/text error body. */ }
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
      throw new BridgeError(timeout ? 'AV_HOST_TIMEOUT' : 'AV_HOST_UNAVAILABLE', timeout ? 'AV Host response timed out; operation outcome may be unknown' : 'AV Host is unavailable', timeout ? 504 : 503);
    }
    if (!response.ok || !json || (json.code !== 0 && json.ok !== true)) {
      const code = json?.error?.code ?? json?.errorCode;
      const typed = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) && !code.includes(token);
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      throw new BridgeError(typed ? code : 'AV_HOST_REJECTED', safeMessage(json?.error?.message ?? json?.message), status);
    }
    return json.data;
  }
  return {
    invokeHost: (command, params, requestId) => request('/v1/invoke', { command, params, requestId }),
    probeHost: () => request('/v1/status'),
    hostRequest: request,
  };
}
