#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/common.sh"
"${PYTHON_BIN:-python3}" "$script_dir/probe.py" --qq-dir "$qq_dir" --napcat-dir "$napcat_dir"
"${PYTHON_BIN:-python3}" - "$bridge_dir" "${KOISHI_RTC_QQ_AUDIO_SHIM_PATH:-$bridge_dir/audio/qq-pulse-guard.so}" <<'PYGUARD'
import json,sys,hashlib,platform
from pathlib import Path
root=Path(sys.argv[1]); binary=Path(sys.argv[2]); manifest_path=root/'runtime/install-manifest.json'
manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
required=bool(manifest.get('mediaEnabled')); report={'audioShim':str(binary),'required':required,'exists':binary.is_file(),'architecture':platform.machine()}
if binary.is_file():
 data=binary.read_bytes(); machine={'aarch64':183,'arm64':183,'x86_64':62,'amd64':62}.get(platform.machine().lower())
 report['architectureMatches']=len(data)>20 and data[:5]==b'\x7fELF\x02' and data[5]==1 and int.from_bytes(data[18:20],'little')==machine
 report['sha256']=hashlib.sha256(data).hexdigest()
 expected=manifest.get('audioShimSHA256') if str(binary)==manifest.get('audioShim') else None
 report['installedHashMatches']=report['sha256']==expected if expected else None
print(json.dumps({'qqPulseGuard':report},indent=2))
if required and (not report['exists'] or not report.get('architectureMatches') or report.get('installedHashMatches') is False):sys.exit(1)
PYGUARD
if [[ ${1:-} == --runtime ]]; then
  # Authenticated read-only status. Token is passed over stdin, not in process arguments.
  "${PYTHON_BIN:-python3}" - "$token_file" "${KOISHI_RTC_QQ_BRIDGE_PORT:-6110}" <<'PY'
import json,sys,urllib.request
from pathlib import Path
token=Path(sys.argv[1]).read_text().strip()
request=urllib.request.Request('http://127.0.0.1:'+sys.argv[2]+'/v1/capabilities',headers={'Authorization':'Bearer '+token})
with urllib.request.urlopen(request,timeout=5) as response:print(json.dumps(json.load(response),indent=2))
PY
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--runtime]\n' "$0" >&2
  exit 2
fi
