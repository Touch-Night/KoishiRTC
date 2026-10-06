#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Derived from ClaudiaGardner/maibot-qq-voice-call (GPL-3.0-only).
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
default_bridge_dir=$(cd -- "$script_dir/.." && pwd -P)
bridge_dir=${KOISHI_RTC_QQ_BRIDGE_DIR:-$default_bridge_dir}
runtime_dir="$bridge_dir/runtime"
logs_dir="$bridge_dir/logs"
token_file=${KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE:-$runtime_dir/control.token}
pulse_runtime_dir="$runtime_dir/pulse"
pulse_socket="$pulse_runtime_dir/native"
pulse_server="unix:$pulse_socket"

read_saved_path() {
  local name=$1
  local value=""
  if [[ -f "$runtime_dir/$name" ]]; then
    IFS= read -r value <"$runtime_dir/$name" || true
  fi
  printf '%s' "$value"
}

qq_dir=${KOISHI_RTC_QQ_QQ_DIR:-$(read_saved_path qq-dir)}
napcat_dir=${KOISHI_RTC_QQ_NAPCAT_DIR:-$(read_saved_path napcat-dir)}
saved_bridge_port=$(read_saved_path bridge-port)
saved_av_port=$(read_saved_path av-port)
export KOISHI_RTC_QQ_BRIDGE_PORT=${KOISHI_RTC_QQ_BRIDGE_PORT:-${saved_bridge_port:-6110}}
export KOISHI_RTC_QQ_AV_HOST_PORT=${KOISHI_RTC_QQ_AV_HOST_PORT:-${saved_av_port:-6111}}
avsdk_path=${KOISHI_RTC_QQ_AVSDK_PATH:-${qq_dir:+$qq_dir/resources/app/avsdk/libAVSDKPlugin.so}}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    return 1
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    printf 'required file was not found: %s\n' "$1" >&2
    return 1
  fi
}

ensure_runtime_dirs() {
  install -d -m 0700 "$runtime_dir" "$pulse_runtime_dir"
  install -d -m 0750 "$logs_dir"
}
