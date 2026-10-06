// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from './controller.mjs';
import { createHostTransport, createHttpServer, loadToken, parseSettings } from './http.mjs';

let controller = null, server = null, settings = null;
export async function plugin_init(ctx) {
  if (controller || server) throw new Error('Koishi RTC QQ bridge is already initialized');
  settings = parseSettings(process.env, path.dirname(fileURLToPath(import.meta.url)));
  const token = loadToken(settings);
  controller = createController({ session: ctx.core?.context?.session,
    core: ctx.core, selfInfo: ctx.core?.selfInfo, mediaEnabled: settings.mediaEnabled,
    ...createHostTransport(settings, token) });
  server = createHttpServer(controller, token);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(settings.controlPort, settings.controlHost, resolve);
    });
    controller.start();
    ctx.logger?.info(`Koishi RTC QQ bridge listening on ${settings.controlHost}:${settings.controlPort}; media=${settings.mediaEnabled}`);
  } catch (error) { await plugin_cleanup(); throw error; }
}
export async function plugin_cleanup() {
  await controller?.stop(); controller = null;
  if (server?.listening) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  server = null; settings = null;
}
export const plugin_get_config = async () => ({ controlHost: settings?.controlHost ?? '127.0.0.1',
  controlPort: settings?.controlPort ?? 6110, mediaEnabled: settings?.mediaEnabled ?? false });
export const plugin_config_ui = [];
