#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Derived from ClaudiaGardner/maibot-qq-voice-call (GPL-3.0-only).
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=common.sh
source "$script_dir/common.sh"

require_command xvfb-run
require_command flock
require_file "$qq_dir/qq"
require_file "$avsdk_path"
require_file "$bridge_dir/av-host/host.cjs"
require_file "$token_file"
"$script_dir/audio-control.sh" start >/dev/null
ensure_runtime_dirs

exec 9>"$runtime_dir/av-host.lock"
if ! flock -n 9; then
  printf '[KoishiRTCQQAVHost] another supervised AV host is already running\n' >&2
  exit 0
fi

export KOISHI_RTC_QQ_AV_HOST=1
export KOISHI_RTC_QQ_AV_HOST_ENTRY="$bridge_dir/av-host/host.cjs"
export KOISHI_RTC_QQ_BRIDGE_DIR="$bridge_dir"
export KOISHI_RTC_QQ_QQ_DIR="$qq_dir"
export KOISHI_RTC_QQ_AVSDK_PATH="$avsdk_path"
export KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE="$token_file"
export PULSE_SERVER="$pulse_server"
if [[ ${KOISHI_RTC_QQ_RESTART_AV_HOST:-1} == 1 ]]; then
  export KOISHI_RTC_QQ_AV_HOST_SUPERVISED=1
else
  unset KOISHI_RTC_QQ_AV_HOST_SUPERVISED
fi
avsdk_dir=$(dirname -- "$avsdk_path")
export LD_LIBRARY_PATH="$avsdk_dir:$avsdk_dir/bugly${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

audio_shim_path=${KOISHI_RTC_QQ_AUDIO_SHIM_PATH:-$bridge_dir/audio/qq-pulse-guard.so}
require_file "$audio_shim_path"
qq_audio_env=(env)
if [[ -n $audio_shim_path ]]; then
  qq_audio_env+=( -u PULSE_LATENCY_MSEC
    "LD_PRELOAD=$audio_shim_path${LD_PRELOAD:+:$LD_PRELOAD}"
    "KOISHI_RTC_QQ_PULSE_SOURCE=koishi_rtc_qq_mic_source"
    "KOISHI_RTC_QQ_PULSE_SINK=koishi_rtc_qq_speaker" )
fi

while true; do
  set +e
  # Xvfb is an X11 session even when the desktop running this launcher uses Wayland.
  xvfb-run -a env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 "${qq_audio_env[@]}" "$qq_dir/qq" \
    --no-sandbox \
    --user-data-dir="$runtime_dir/av-host-profile"
  status=$?
  set -e
  if [[ ${KOISHI_RTC_QQ_RESTART_AV_HOST:-1} != 1 ]]; then
    exit "$status"
  fi
  printf '[KoishiRTCQQAVHost] exited with status %s; restarting\n' "$status" >&2
  sleep 2
done
