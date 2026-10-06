// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'koishi-rtc-bootstrap.json'), 'utf8'));
if (process.env.KOISHI_RTC_QQ_AV_HOST === '1') {
  require(config.hostEntry);
} else if (process.env.KOISHI_RTC_QQ_LOAD_NAPCAT === '1') {
  Promise.resolve().then(() => require(config.napcatLoader)).catch(error => {
    console.error('[KoishiRTCQQ] NapCat startup failed:', error.message);
    process.exitCode = 1;
    require('electron').app.quit();
  });
} else {
  require(path.resolve(__dirname, config.originalMain));
}
