#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Derived from ClaudiaGardner/maibot-qq-voice-call (GPL-3.0-only).
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$script_dir/common.sh"

require_command curl
require_file "$qq_dir/qq"
require_file "$avsdk_path"
require_file "$token_file"
"$script_dir/audio-control.sh" start >/dev/null
ensure_runtime_dirs

if ! curl -fsS "http://127.0.0.1:${KOISHI_RTC_QQ_AV_HOST_PORT:-6111}/healthz" \
  >/dev/null 2>&1; then
  nohup "$script_dir/run-av-host.sh" >>"$logs_dir/av-host.log" 2>&1 &
  printf '%s\n' "$!" >"$runtime_dir/av-host.pid"
  for _ in $(seq 1 80); do
    if curl -fsS "http://127.0.0.1:${KOISHI_RTC_QQ_AV_HOST_PORT:-6111}/healthz" \
      >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
fi
if ! curl -fsS "http://127.0.0.1:${KOISHI_RTC_QQ_AV_HOST_PORT:-6111}/healthz" \
  >/dev/null 2>&1; then
  printf 'AV host did not become ready; inspect %s\n' "$logs_dir/av-host.log" >&2
  exit 1
fi

export KOISHI_RTC_QQ_BRIDGE_DIR="$bridge_dir"
export KOISHI_RTC_QQ_QQ_DIR="$qq_dir"
export KOISHI_RTC_QQ_AVSDK_PATH="$avsdk_path"
export KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE="$token_file"
export PULSE_SERVER="$pulse_server"
export KOISHI_RTC_QQ_DATA_DIR=${KOISHI_RTC_QQ_DATA_DIR:-$runtime_dir/qq-data}
install -d -m 0700 "$KOISHI_RTC_QQ_DATA_DIR"
unset KOISHI_RTC_QQ_AV_HOST KOISHI_RTC_QQ_AV_HOST_ENTRY

qq_args=(--no-sandbox "--user-data-dir=$runtime_dir/qq-electron-profile")
if [[ -n ${KOISHI_RTC_QQ_BOT_UIN:-} ]]; then
  qq_args+=(-q "$KOISHI_RTC_QQ_BOT_UIN")
fi
# Restrict the X11 override to QQ and its children; preserve the desktop environment.
exec xvfb-run -a env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 "$qq_dir/qq" "${qq_args[@]}" "$@"
