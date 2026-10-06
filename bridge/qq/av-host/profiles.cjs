// SPDX-License-Identifier: GPL-3.0-only
// Exact official binaries audited in ../{native-evidence,windows/native-evidence,macos/native-evidence}.json.
'use strict';
module.exports = Object.freeze([
  { id: 'qq-linux-3.2.34-53644-arm64', platform: 'linux', arch: 'arm64', qqVersion: '3.2.34-53644', roomIdleQuery: true, video: true, privateScreen: true, librarySHA256: '07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c' },
  { id: 'qq-linux-3.2.34-53644-x64', platform: 'linux', arch: 'x64', qqVersion: '3.2.34-53644', roomIdleQuery: true, video: true, privateScreen: true, librarySHA256: 'c143c4e8ac94c20bcefb037e7062fbeccd0528bd746108d6bf1f0ae8e1710a8b' },
  { id: 'qq-win32-9.9.36-53644-x64', platform: 'win32', arch: 'x64', qqVersion: '9.9.36-53644', video: true, privateScreen: true, roomIdleQuery: true, librarySHA256: '199a6e8d2849908ce33ea21085be702b69ee6938a67191b3e0dbe753caab93ac' },
  ...['arm64', 'x64'].map(arch => ({ id: `qq-macos-7.0.2-53644-${arch}`, platform: 'darwin', arch, qqVersion: '7.0.2-53644', video: true, privateScreen: true, roomIdleQuery: true, librarySHA256: '8dcddc9ade6120ba1fecb7f8961d401dded8c4881ce3e12b5a023465089c64c6' }))
]);
