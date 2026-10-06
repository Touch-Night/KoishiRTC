#!/usr/bin/env python3
"""Install the Telegram sidecar in its own venv, or run an offline doctor."""

import argparse
import asyncio
import gc
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import venv


HERE = Path(__file__).resolve().parent
DEFAULT_VENV = HERE.parents[1] / "runtime" / "telegram-venv"
REQUIREMENTS = HERE / "requirements.txt"


def expected_versions():
    return dict(line.split("==", 1) for line in REQUIREMENTS.read_text().splitlines()
                if line and not line.startswith("#"))


async def native_smoke():
    # Importing and constructing is intentionally separate from connecting an account,
    # enumerating devices, starting PyTgCalls, or creating a call.
    import pytgcalls  # noqa: F401
    import telethon  # noqa: F401
    from ntgcalls import NTgCalls
    from PIL import Image

    versions = {name: importlib.metadata.version(name) for name in expected_versions()}
    if versions != expected_versions():
        raise RuntimeError("Dependency versions do not match requirements.txt; run install.")
    binding = NTgCalls()
    try:
        encoded = io.BytesIO()
        Image.new("RGB", (2, 2), (0, 0, 0)).save(encoded, format="JPEG")
        encoded.seek(0)
        with Image.open(encoded) as decoded:
            decoded.load()
            if decoded.size != (2, 2):
                raise RuntimeError("JPEG codec smoke test failed.")
    finally:
        # NTgCalls 3.0.1 exposes stop(chat_id), but no close()/shutdown(). No calls
        # exist here; release the binding and let the isolated doctor process exit.
        del binding
        gc.collect()
    return {"ok": True, "python": platform.python_version(),
            "platform": platform.system(), "machine": platform.machine(),
            "versions": versions, "nativeSmoke": True, "jpegCodec": True,
            "accountConnected": False}


def venv_python(directory):
    return directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run_doctor(python):
    result = subprocess.run([str(python), str(Path(__file__).resolve()), "--native-smoke"],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Offline Telegram doctor failed; verify the pinned native wheels and system libraries.")
    # Print only our structured result, never upstream/native diagnostic output.
    report = json.loads(result.stdout.strip().splitlines()[-1])
    if report.get("ok") is not True or report.get("nativeSmoke") is not True:
        raise RuntimeError("Offline Telegram doctor returned an invalid result.")
    print(json.dumps(report))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "doctor"), nargs="?", default="install")
    parser.add_argument("--venv", type=Path, default=DEFAULT_VENV,
                        help="isolated environment directory (default: runtime/telegram-venv)")
    parser.add_argument("--native-smoke", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if sys.version_info < (3, 10):
            raise RuntimeError("Python 3.10 or newer is required.")
        if args.native_smoke:
            print(json.dumps(asyncio.run(native_smoke())))
            return 0
        directory = args.venv.expanduser().absolute()
        python = venv_python(directory)
        if args.action == "install":
            if directory.exists() and any(directory.iterdir()) and not (directory / "pyvenv.cfg").is_file():
                raise RuntimeError("The selected directory is not a virtual environment.")
            print("Preparing the isolated Telegram environment.", flush=True)
            venv.EnvBuilder(with_pip=True).create(directory)
            print("Installing the pinned Telegram dependencies and native wheels.", flush=True)
            result = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                                     "--only-binary=ntgcalls,Pillow", "-r", str(REQUIREMENTS)],
                                    capture_output=True, text=True, timeout=600)
            if result.returncode:
                raise RuntimeError("Dependency installation failed; check network access and wheel support for this Python/platform.")
        if not python.is_file() or not (directory / "pyvenv.cfg").is_file():
            raise RuntimeError("The Telegram virtual environment is missing; run install first.")
        run_doctor(python)
        return 0
    except (Exception, KeyboardInterrupt) as error:
        # Installer subprocesses and native libraries can include environment details.
        # Keep failures useful without forwarding their output or traceback.
        message = str(error) if type(error) is RuntimeError else "Telegram setup failed; check the environment and try again."
        print(message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
