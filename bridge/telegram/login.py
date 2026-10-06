#!/usr/bin/env python3
"""Explicit, interactive ordinary-user login; credentials remain in local files."""

import argparse
import asyncio
import getpass
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import warnings


class LoginError(Exception):
    """Only fixed messages suitable for displaying without credentials."""


def load_config(config_path):
    try:
        path = Path(config_path).expanduser()
        if path.stat().st_size > 65536:
            raise LoginError("Telegram config is too large.")
        config = json.loads(path.read_text(encoding="utf-8"))
    except LoginError:
        raise
    except (OSError, ValueError, TypeError):
        raise LoginError("Cannot read Telegram JSON config.") from None
    if not isinstance(config, dict):
        raise LoginError("Telegram config must be a JSON object.")
    api_id = config.get("apiId")
    if type(api_id) is not int or not 0 < api_id <= 2147483647:
        raise LoginError("apiId must be a positive 32-bit integer.")
    api_hash = config.get("apiHash")
    if not isinstance(api_hash, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", api_hash):
        raise LoginError("apiHash must contain 32 hexadecimal characters.")
    self_id = config.get("selfId")
    if type(self_id) not in (str, int) or not re.fullmatch(r"[1-9][0-9]*", str(self_id)):
        raise LoginError("selfId must be the positive numeric ID of the intended user account.")
    session_path = config.get("sessionPath")
    if not isinstance(session_path, str) or not Path(session_path).is_absolute() or not session_path.endswith(".session") or "\0" in session_path:
        raise LoginError("sessionPath must be an absolute path ending in .session.")
    return {"apiId": api_id, "apiHash": api_hash, "selfId": str(self_id), "sessionPath": session_path}


def prepare_session(session_path):
    path = Path(session_path)
    if path.is_symlink() or path.parent.is_symlink():
        raise LoginError("Session files and their private directory must not be symbolic links.")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "posix":
        if stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
            raise LoginError("The session directory must be private (chmod 700).")
        if path.exists():
            path.chmod(0o600)
    return path


def hidden_input(prompt):
    # getpass must never fall back to echoing a secret when no terminal is present.
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise LoginError("Login requires an interactive terminal with hidden input.")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        return getpass.getpass(prompt)


async def login(config, *, client_factory=None, prompt=hidden_input):
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError

    path = prepare_session(config["sessionPath"])
    factory = client_factory or TelegramClient
    client = factory(str(path), config["apiId"], config["apiHash"])
    # The login operation does not need to retain the phone numbers or names from
    # encountered entities. The sidecar can maintain its own authorized peer cache.
    client.session.save_entities = False
    try:
        await client.connect()
        if not await client.is_user_authorized():
            phone = prompt("Telegram phone number (hidden): ").strip()
            if not re.fullmatch(r"\+[1-9][0-9]{5,14}", phone):
                raise LoginError("Enter an international phone number beginning with +.")
            sent = await client.send_code_request(phone)
            code = prompt("Telegram login code (hidden): ").strip()
            if not re.fullmatch(r"[0-9]{4,8}", code):
                raise LoginError("Enter the numeric login code.")
            try:
                await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
            except SessionPasswordNeededError:
                password = prompt("Telegram two-step verification password (hidden): ")
                if not password:
                    raise LoginError("The two-step verification password must not be empty.")
                await client.sign_in(password=password)
        me = await client.get_me()
        if me is None or getattr(me, "bot", False):
            raise LoginError("This bridge requires an ordinary Telegram user account.")
        if str(me.id) != config["selfId"]:
            raise LoginError("The signed-in account does not match selfId; this session cannot be used by the provider.")
    finally:
        try:
            await client.disconnect()
        finally:
            if os.name == "posix" and path.exists() and not path.is_symlink():
                path.chmod(0o600)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="local JSON credentials file")
    args = parser.parse_args(argv)
    logging.disable(logging.CRITICAL)
    previous_umask = os.umask(0o077)
    try:
        config = load_config(args.config)
        asyncio.run(login(config))
        print("Telegram user session is ready; the configured account identity was verified.")
        return 0
    except LoginError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        # Telegram exceptions can include phone numbers, request details or secrets.
        print("Telegram login did not complete. Check the account, code/password and connection, then retry.", file=sys.stderr)
        return 1
    finally:
        os.umask(previous_umask)


if __name__ == "__main__":
    raise SystemExit(main())
