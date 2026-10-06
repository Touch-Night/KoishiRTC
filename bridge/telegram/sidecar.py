#!/usr/bin/env python3
"""Pinned PyTgCalls 3.0 / NTgCalls 3.0.1 stdio bridge. No device/file capture.

All native media sources are EXTERNAL. stdout is JSONL only; authentication is
performed separately by login.py. A dead parent closes stdin and ends the call.
"""
import asyncio
import base64
import contextlib
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

from media import mix_pcm, jpeg_to_i420, i420_to_jpeg

TERMINAL = {'ended', 'failed'}
EVIDENCE = 'ntgcalls-decoded-frame-and-jpeg-encode'


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class NullWriter:
    """Discard upstream prints without retaining an ever-growing StringIO."""
    encoding = 'utf-8'

    def write(self, value):
        return len(value)

    def flush(self):
        pass

    def isatty(self):
        return False


def now():
    return int(time.time() * 1000)


def decode(data, maximum):
    if not isinstance(data, str) or len(data) > (maximum + 2) // 3 * 4:
        raise Failure('INVALID_MEDIA', 'Invalid encoded media')
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception:
        raise Failure('INVALID_MEDIA', 'Invalid base64') from None
    if len(raw) > maximum:
        raise Failure('INVALID_MEDIA', 'Media exceeds limit')
    return raw


class Bridge:
    def __init__(self, emit):
        self.emit = emit
        self.client = self.sdk = self.types = None
        self.active = None
        self.allowed = set()
        self.provider_id = self.self_id = ''
        self.lock = asyncio.Lock()
        self.media_lock = asyncio.Lock()
        self.audio_lock = asyncio.Lock()
        self.native_lock = asyncio.Lock()
        self.watch_task = None
        self.stopping = False
        self.cleanup_unknown = False

    async def start(self, args):
        if self.sdk:
            raise Failure('ALREADY_STARTED', 'Telegram sidecar is already initialized')
        from login import load_config, prepare_session
        from telethon import TelegramClient
        from pytgcalls import PyTgCalls
        from pytgcalls import types
        from pytgcalls.pytgcalls_session import PyTgCallsSession
        import ntgcalls
        import importlib.metadata
        for name, expected in [('py-tgcalls', '3.0.0'), ('ntgcalls', '3.0.1'), ('Telethon', '1.45.0'), ('Pillow', '12.3.0')]:
            if importlib.metadata.version(name) != expected:
                raise Failure('DEPENDENCY_VERSION', 'Run the pinned Telegram installer')
        config = load_config(Path(args['configPath']))
        self.self_id = str(args['selfId'])
        if config['selfId'] != self.self_id:
            raise Failure('IDENTITY_MISMATCH', 'Config and provider account IDs differ')
        if not Path(config['sessionPath']).is_file():
            raise Failure('LOGIN_REQUIRED', 'Run Telegram login.py before starting the provider')
        prepare_session(config['sessionPath'])
        self.provider_id = args['providerId']
        allowed = args.get('allowedChatIds', [])
        if not isinstance(allowed, list) or len(allowed) > 512 or any(not isinstance(x, str) or not x.lstrip('-').isdigit() or int(x) == 0 for x in allowed):
            raise Failure('INVALID_CONFIG', 'Invalid Telegram chat allowlist')
        self.allowed = set(allowed)
        self.client = TelegramClient(config['sessionPath'], config['apiId'], config['apiHash'], auto_reconnect=False, connection_retries=0, request_retries=1, flood_sleep_threshold=0)
        await self.client.connect()
        if not await self.client.is_user_authorized():
            raise Failure('LOGIN_REQUIRED', 'Run Telegram login.py before starting the provider')
        me = await self.client.get_me()
        if not me or me.bot or str(me.id) != self.self_id:
            raise Failure('IDENTITY_MISMATCH', 'Telegram requires the configured ordinary user account')
        self.types = types
        # Suppress the optional upstream update check/banner; no code is fetched.
        PyTgCallsSession.notice_displayed = True
        bridge = self

        class Calls(PyTgCalls):
            async def _handle_connection_changed(self, chat_id, net_state):
                call = bridge.active
                presentation = net_state.kind == ntgcalls.ConnectionKind.PRESENTATION
                if presentation:
                    # The separate screen connection normally connects/closes
                    # while the main call remains live. Preserve its wait future,
                    # but do not run upstream's main-call discard/cache clear.
                    pending = self._wait_connect.get(chat_id)
                    if pending and not pending.done():
                        await super()._handle_connection_changed(chat_id, net_state)
                    return
                if call and call['chat'] == chat_id and call['snapshot']['state'] == 'connected' and net_state.state != ntgcalls.ConnectionState.CONNECTED:
                    await bridge.terminate(call, 'failed', 'Telegram media connection was lost; reconnect explicitly')
                    return
                await super()._handle_connection_changed(chat_id, net_state)
        self.sdk = Calls(self.client)
        self.sdk.add_handler(self.update)
        await self.sdk.start()
        self.watch_task = asyncio.create_task(self.watch())
        return {'selfId': self.self_id, 'platform': 'telegram', 'bot': False, 'versions': {'py-tgcalls': '3.0.0', 'ntgcalls': '3.0.1', 'Telethon': '1.45.0'}, 'calls': []}

    def publish(self, call):
        call['snapshot']['updatedAt'] = now()
        self.emit({'type': 'call', 'call': dict(call['snapshot'])})

    def new_call(self, chat, direction, state):
        stamp = now()
        call = {'chat': chat, 'snapshot': {'id': f'{self.provider_id}:{uuid.uuid4()}', 'providerId': self.provider_id, 'account': {'platform': 'telegram', 'selfId': self.self_id}, 'kind': 'direct' if chat > 0 else 'group', 'targetId': str(chat), 'direction': direction, 'state': state, 'createdAt': stamp, 'updatedAt': stamp, 'participants': [{'id': str(chat), 'identity': 'platform'}] if chat > 0 else [], 'muted': False}, 'task': None, 'cleanup_task': None, 'tracks': {}, 'sending': {}, 'video_seq': {}, 'ssrc': {}, 'audio_seq': 0, 'generation': 0, 'decoding': set()}
        self.active = call
        self.publish(call)
        return call

    def current(self, call_id, connected=False):
        call = self.active
        if not call or call['snapshot']['id'] != call_id or call['snapshot']['state'] in TERMINAL:
            raise Failure('CALL_ENDED', 'Telegram call ended or belongs to an old session')
        if connected and call['snapshot']['state'] != 'connected':
            raise Failure('NOT_CONNECTED', 'Telegram call is not connected')
        return call

    def finish(self, call, state, message=None):
        if call['snapshot']['state'] in TERMINAL:
            return
        call['generation'] += 1
        call['tracks'].clear()
        call['sending'].clear()
        call['snapshot']['state'] = state
        if message:
            call['snapshot']['error'] = message
        self.publish(call)

    async def _cleanup(self, call, initiator):
        from ntgcalls import ConnectionNotFound
        errors = []
        task = call['task']
        if task and task is not initiator and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        # Stop media even if signaling has disconnected. Unlike leave_call(),
        # these independent steps still discard a pending invitation when there
        # was never a native connection, or connect() has just been cancelled.
        try:
            # Do not wait for media_lock: a screen handshake may hold it while
            # awaiting a network callback. No post-connect media method creates
            # calls anymore, so stopping also interrupts that stalled operation.
            async def stop_native():
                async with self.native_lock:
                    await self.sdk._binding.stop(call['chat'])
            await asyncio.wait_for(stop_native(), 5)
        except ConnectionNotFound:
            pass
        except Exception:
            errors.append('native')
        try:
            leave = (self.sdk._app.discard_call(call['chat'], False) if call['chat'] > 0
                     else self.sdk._app.leave_group_call(call['chat']))
            await asyncio.wait_for(leave, 5)
        except Exception:
            errors.append('signaling')
        # The pinned SDK stores pending DH/connection futures separately from
        # native calls. Release these even when network cleanup is uncertain.
        future = self.sdk._wait_connect.pop(call['chat'], None)
        pending = self.sdk._p2p_configs.get(call['chat'])
        for item in (future, getattr(pending, 'wait_data', None)):
            if item and not item.done():
                item.cancel()
        self.sdk._clear_cache(call['chat'])
        if errors:
            self.cleanup_unknown = True
        return not errors

    async def terminate(self, call, state='ended', message=None):
        if state == 'failed':
            self.finish(call, state, message)
        if not call['cleanup_task']:
            if call['snapshot']['state'] not in TERMINAL:
                call['snapshot']['state'] = 'ending'
                call['generation'] += 1
                call['tracks'].clear()
                call['sending'].clear()
                self.publish(call)
            call['cleanup_task'] = asyncio.create_task(self._cleanup(call, asyncio.current_task()))
        clean = await asyncio.shield(call['cleanup_task'])
        if call['snapshot']['state'] not in TERMINAL:
            self.finish(call, state if clean else 'failed', message if clean else 'Telegram cleanup is uncertain; restart the backend explicitly')
        return clean

    def capture(self, call, invite_kind=None):
        from ntgcalls import MediaSource
        from pytgcalls.types.raw import Stream, AudioStream, AudioParameters, VideoStream, VideoParameters
        video = lambda: VideoStream(MediaSource.EXTERNAL, '', VideoParameters(width=640, height=360, frame_rate=15))
        return Stream(microphone=AudioStream(MediaSource.EXTERNAL, '', AudioParameters(bitrate=48000, channels=2)), camera=video() if 'camera' in call['sending'] or invite_kind == 'camera' else None, screen=video() if 'screen' in call['sending'] or invite_kind == 'screen' else None)

    async def record(self, call):
        from pytgcalls.types.raw import AudioParameters
        stream = self.types.RecordStream(True, AudioParameters(bitrate=48000, channels=2), camera=any(t['kind'] == 'camera' for t in call['tracks'].values()), screen=any(t['kind'] == 'screen' for t in call['tracks'].values()))
        await self.configure(call, stream, playback=True)

    async def configure(self, call, stream, playback=False):
        from ntgcalls import StreamMode
        from pytgcalls.methods.utilities.stream_params import StreamParams
        # play()/record() create calls when native state has vanished. Once the
        # initial connection exists, use the pinned non-dialing native API only.
        description = await (StreamParams.get_record_params(stream) if playback else StreamParams.get_stream_params(stream))
        async with self.native_lock:
            await self.sdk._binding.set_stream_sources(call['chat'], StreamMode.PLAYBACK if playback else StreamMode.CAPTURE, description)
        if not playback and call['chat'] < 0:
            await self.sdk._join_presentation(call['chat'], description.screen is not None)

    async def connect(self, call, create=False, media='audio'):
        try:
            config = self.types.CallConfig(timeout=45) if call['chat'] > 0 else self.types.GroupCallConfig(auto_start=create)
            # A video invitation declares an external source without opening a
            # camera. Disable this empty source after handshake until sendVideo.
            invite_kind = 'camera' if media == 'video' else 'screen' if media == 'screen' else None
            await self.sdk.play(call['chat'], self.capture(call, invite_kind), config)
            if self.active is not call or call['snapshot']['state'] in TERMINAL:
                await self.terminate(call)
                return
            if invite_kind:
                await self.configure(call, self.capture(call))
            await self.record(call)
            if call['chat'] < 0:
                await self.refresh_members(call)
            call['snapshot']['state'] = 'connected'
            self.publish(call)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.terminate(call, 'failed', f'Telegram connect failed ({type(exc).__name__})')

    async def refresh_members(self, call):
        participants = await self.sdk.get_participants(call['chat']) or []
        if self.active is not call or call['snapshot']['state'] in TERMINAL:
            return
        members, ssrc = [], {}
        for participant in participants:
            uid = str(participant.user_id)
            members.append({'id': uid, 'identity': 'platform'})
            for kind, info in [('camera', participant.video_info), ('screen', participant.presentation_info)]:
                if info:
                    for group in info.sources:
                        for source in group.ssrcs:
                            ssrc[(kind, int(source) & 0xffffffff)] = uid
        call['snapshot']['participants'] = members
        call['ssrc'] = ssrc
        allowed = {m['id'] for m in members}
        for key in list(call['tracks']):
            if call['tracks'][key]['participantId'] not in allowed:
                del call['tracks'][key]
        self.publish(call)

    async def update(self, _, update):
        types = self.types
        call = self.active
        if isinstance(update, types.ChatUpdate):
            if update.status & types.ChatUpdate.Status.INCOMING_CALL:
                if not self.stopping and not self.cleanup_unknown and str(update.chat_id) in self.allowed and (not call or call['snapshot']['state'] in TERMINAL and call['cleanup_task'] and call['cleanup_task'].done()):
                    self.new_call(update.chat_id, 'incoming', 'ringing')
            elif call and call['chat'] == update.chat_id and update.status & types.ChatUpdate.Status.LEFT_CALL:
                await self.terminate(call)
            return
        if not call or call['chat'] != update.chat_id or call['snapshot']['state'] != 'connected':
            return
        if isinstance(update, types.UpdatedGroupCallParticipant):
            await self.refresh_members(call)
            return
        if not isinstance(update, types.StreamFrames) or update.direction != types.Direction.INCOMING:
            return
        if update.device == types.Device.MICROPHONE:
            data = mix_pcm([f.frame for f in update.frames[:64]])
            if data:
                self.emit({'type': 'audio', 'frame': {'callId': call['snapshot']['id'], 'encoding': 'pcm_s16le', 'sampleRate': 48000, 'channels': 2, 'sequence': call['audio_seq'], 'timestamp': now(), 'data': base64.b64encode(data).decode() }}, media=True)
                call['audio_seq'] += 1
            return
        kind = 'camera' if update.device == types.Device.CAMERA else 'screen' if update.device == types.Device.SCREEN else None
        if kind is None:
            return
        for frame in update.frames[:4]:
            uid = str(call['chat']) if call['chat'] > 0 else call['ssrc'].get((kind, int(frame.ssrc) & 0xffffffff))
            key = f'{kind}:{uid}'
            track = call['tracks'].get(key)
            if not track or key in call['decoding']:
                continue
            call['decoding'].add(key)
            generation = call['generation']
            try:
                rotation = getattr(frame.info.rotation, 'value', frame.info.rotation)
                data, width, height = await asyncio.to_thread(i420_to_jpeg, frame.frame, frame.info.width, frame.info.height, rotation)
                if self.active is not call or call['generation'] != generation or call['tracks'].get(key) is not track or call['snapshot']['state'] != 'connected':
                    continue
                stamp = now()
                track.update(hasFrame=True, decodedFrameAt=stamp, width=width, height=height)
                sequence = call['video_seq'].get(key, -1) + 1
                call['video_seq'][key] = sequence
                self.emit({'type': 'video', 'frame': {'callId': call['snapshot']['id'], 'trackId': key, 'participantId': uid, 'kind': kind, 'encoding': 'jpeg', 'evidence': EVIDENCE, 'sequence': sequence, 'timestamp': stamp, 'width': width, 'height': height, 'data': base64.b64encode(data).decode()}}, media=True)
            except (ValueError, OSError):
                pass
            finally:
                call['decoding'].discard(key)

    async def watch(self):
        while not self.stopping:
            await asyncio.sleep(2)
            try:
                if not self.client.is_connected():
                    raise Failure('TELEGRAM_OFFLINE', 'Telegram signaling disconnected; restart explicitly')
                call = self.active
                if call and call['snapshot']['state'] == 'connected':
                    if call['chat'] not in await self.sdk.calls:
                        await self.terminate(call, 'failed', 'Telegram native call disappeared')
            except asyncio.CancelledError:
                raise
            except Exception:
                self.stopping = True
                if self.active:
                    with contextlib.suppress(Exception):
                        await self.terminate(self.active, 'failed', 'Telegram signaling or native status disconnected; restart explicitly')
                self.emit({'type': 'offline', 'error': 'Telegram signaling or native status disconnected'})
                return

    def video_state(self, call):
        return {'callId': call['snapshot']['id'], 'supported': True, 'tracks': list(call['tracks'].values()), 'sending': dict(call['sending'])}

    async def operation(self, op, args):
        if op == 'start':
            return await self.start(args)
        if not self.sdk or self.stopping:
            raise Failure('TELEGRAM_OFFLINE', 'Telegram sidecar is offline')
        if op == 'ping':
            return {'connected': self.client.is_connected()}
        if op == 'dial':
            async with self.lock:
                if self.cleanup_unknown:
                    raise Failure('RESULT_UNKNOWN', 'Previous Telegram cleanup is uncertain; restart the backend explicitly')
                target = args.get('targetId')
                if target not in self.allowed:
                    raise Failure('CHAT_NOT_ALLOWED', 'Telegram target is not allowlisted')
                chat = int(target)
                if (args.get('kind') == 'direct') != (chat > 0) or args.get('kind') not in ('direct', 'group'):
                    raise Failure('INVALID_TARGET', 'Telegram direct IDs are positive and group IDs are negative')
                if args.get('media', 'audio') not in ('audio', 'video', 'screen') or chat < 0 and args.get('media', 'audio') != 'audio':
                    raise Failure('INVALID_REQUEST', 'Group calls must start as audio; enable video explicitly afterwards')
                if self.active and self.active['snapshot']['state'] not in TERMINAL:
                    raise Failure('ACCOUNT_BUSY', 'Telegram account already has a call')
                if self.active and (not self.active['cleanup_task'] or not self.active['cleanup_task'].done()):
                    raise Failure('ACCOUNT_BUSY', 'Previous Telegram call cleanup is still pending')
                # Resolve through Telegram before emitting an actionable call.
                try:
                    entity = await self.client.get_entity(chat)
                except ValueError:
                    # A freshly logged-in Telethon session has no access-hash
                    # cache. Resolve only the selected existing dialog, without
                    # exposing the rest of the account's dialogs to consumers.
                    entity = None
                    async for dialog in self.client.iter_dialogs(limit=500):
                        if dialog.id == chat:
                            entity = dialog.entity
                            break
                    if entity is None:
                        raise Failure('TARGET_UNRESOLVED', 'Open a dialog with this user/group in Telegram first; target was not found')
                if getattr(entity, 'bot', False):
                    raise Failure('INVALID_TARGET', 'Telegram bots cannot receive ordinary user calls')
                if self.active and self.active['snapshot']['state'] not in TERMINAL:
                    raise Failure('ACCOUNT_BUSY', 'Telegram account received another call while resolving the target')
                call = self.new_call(chat, 'outgoing', 'dialing' if chat > 0 else 'connecting')
                call['task'] = asyncio.create_task(self.connect(call, args.get('groupMode') == 'create', args.get('media', 'audio')))
                return call['snapshot']
        call = self.current(args.get('callId'), op not in ('accept', 'reject', 'hangup'))
        if op == 'accept':
            async with self.lock:
                if call['snapshot']['state'] != 'ringing':
                    raise Failure('INVALID_STATE', 'Telegram call is not ringing')
                call['snapshot']['state'] = 'connecting'
                self.publish(call)
                call['task'] = asyncio.create_task(self.connect(call))
            return None
        if op in ('hangup', 'reject'):
            if op == 'reject' and call['snapshot']['state'] != 'ringing':
                raise Failure('INVALID_STATE', 'Only ringing calls can be rejected')
            if not await self.terminate(call):
                raise Failure('RESULT_UNKNOWN', 'Telegram cleanup is uncertain; restart the backend explicitly')
            return None
        async with (self.audio_lock if op in ('audio.write', 'audio.clear', 'mute') else self.media_lock):
            self.current(args['callId'], True)
            if op == 'audio.write':
                data = decode(args['data'], 1920)
                if len(data) != 1920:
                    raise Failure('INVALID_AUDIO', 'NTgCalls external audio requires exactly 10 ms stereo PCM')
                if call['snapshot']['muted']:
                    raise Failure('MUTED', 'Telegram audio is muted')
                async with self.native_lock:
                    await self.sdk.send_frame(call['chat'], self.types.Device.MICROPHONE, data)
                return {'submittedBytes': len(data)}
            if op == 'audio.clear':
                # send_external_frame is synchronous native submission; this lock
                # fences prior submissions. Already submitted audio cannot retract.
                return {'cleared': True}
            if op == 'mute':
                muted = args.get('muted')
                if type(muted) is not bool:
                    raise Failure('INVALID_REQUEST', 'muted must be boolean')
                async with self.native_lock:
                    await (self.sdk.mute(call['chat']) if muted else self.sdk.unmute(call['chat']))
                call['snapshot']['muted'] = muted
                self.publish(call)
                return None
            if op == 'video.state':
                return self.video_state(call)
            if op == 'video.sources':
                return [{'id': 'external-frames', 'kind': kind, 'name': 'Consumer-provided JPEG frames', 'sourceType': 'frames', 'channels': [kind]} for kind in ('camera', 'screen')]
            if op == 'video.subscribe':
                kind, uid = args.get('kind'), args.get('participantId')
                if kind not in ('camera', 'screen') or not any(p['id'] == uid for p in call['snapshot']['participants']):
                    raise Failure('INVALID_TRACK', 'Select a current Telegram participant and video channel')
                key = f'{kind}:{uid}'
                if key not in call['tracks']:
                    if len(call['tracks']) >= 4:
                        raise Failure('VIDEO_LIMIT', 'At most four video subscriptions')
                    track = {'trackId': key, 'participantId': uid, 'kind': kind, 'available': None, 'subscribed': True, 'hasFrame': False, 'firstFrameAt': None, 'decodedFrameAt': None}
                    call['tracks'][key] = track
                    try:
                        await self.record(call)
                    except Exception:
                        call['tracks'].pop(key, None)
                        raise
                return call['tracks'][key]
            if op == 'video.unsubscribe':
                call['tracks'].pop(args.get('trackId'), None)
                await self.record(call)
                return None
            if op in ('video.send', 'video.stop', 'video.clear'):
                kind = args.get('kind')
                if op != 'video.clear' and kind not in ('camera', 'screen'):
                    raise Failure('INVALID_SOURCE', 'Invalid video channel')
                if op == 'video.send':
                    framing = args.get('framing', 'full')
                    if args.get('sourceId') != 'external-frames' or framing not in ('full', 'portrait-safe') or 'framing' in args and kind != 'camera':
                        raise Failure('INVALID_SOURCE', 'Only explicit external JPEG sources are supported')
                    if call['chat'] > 0 and any(channel != kind for channel in call['sending']):
                        raise Failure('UNSUPPORTED_VIDEO_COMBINATION', 'NTgCalls private calls allow camera or screen; stop the current video channel first')
                    old = call['sending'].get(kind)
                    if old and old.get('framing', 'full') == framing:
                        return self.video_state(call)
                    call['sending'][kind] = {'sourceId': 'external-frames', 'state': 'starting', **({'framing': framing} if kind == 'camera' else {})}
                else:
                    call['generation'] += 1
                    if op == 'video.clear':
                        call['tracks'].clear()
                        call['sending'].clear()
                    else:
                        call['sending'].pop(kind, None)
                try:
                    await self.configure(call, self.capture(call))
                    if op == 'video.clear':
                        await self.record(call)
                except Exception:
                    if kind in call['sending']:
                        call['sending'][kind]['state'] = 'failed'
                    raise
                if op == 'video.send':
                    call['sending'][kind].update(state='sending', evidence='ntgcalls-external-source-configured')
                    call['sending'][kind]['sequence'] = -1
                return self.video_state(call)
            if op == 'video.write':
                kind = args.get('kind')
                output = call['sending'].get(kind)
                if not output or output['state'] != 'sending':
                    raise Failure('VIDEO_SOURCE_REQUIRED', 'Explicitly enable this video output first')
                sequence = args.get('sequence')
                if type(sequence) is not int or sequence < 0 or sequence <= output.get('sequence', -1):
                    raise Failure('VIDEO_SEQUENCE', 'Video sequences must increase')
                output['sequence'] = sequence
                raw = decode(args.get('data'), 256 * 1024)
                data, width, height = await asyncio.to_thread(jpeg_to_i420, raw, args.get('width'), args.get('height'), output.get('framing', 'full'))
                self.current(args['callId'], True)
                device = self.types.Device.CAMERA if kind == 'camera' else self.types.Device.SCREEN
                async with self.native_lock:
                    await self.sdk.send_frame(call['chat'], device, data, self.types.Frame.Info(capture_time=now(), width=width, height=height))
                return {'callId': args['callId'], 'kind': kind, 'sequence': sequence, 'state': 'submitted', 'acceptedBytes': len(raw), 'evidence': 'ntgcalls-i420-input-submit'}
        raise Failure('UNKNOWN_OPERATION', 'Unknown Telegram operation')

    async def close(self):
        self.stopping = True
        if self.watch_task and self.watch_task is not asyncio.current_task():
            self.watch_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.watch_task
        call = self.active
        if call and self.sdk:
            with contextlib.suppress(Exception):
                await self.terminate(call)
        if self.client:
            await asyncio.wait_for(self.client.disconnect(), 5)


async def main():
    os.umask(0o077)
    protocol = sys.stdout.buffer
    # Third-party prints/logs can contain peer/account identifiers. Keep them off
    # the protocol and do not persist them; return bounded exception class names.
    sys.stdout = NullWriter()
    logging.disable(logging.CRITICAL)
    queue = asyncio.Queue(maxsize=64)
    queued_bytes = 0

    def emit(value, media=False):
        nonlocal queued_bytes
        packet = json.dumps(value, separators=(',', ':')).encode() + b'\n'
        if queued_bytes + len(packet) > 1024 * 1024 or queue.full():
            if media:
                return
            raise Failure('BACKPRESSURE', 'Telegram IPC output is full')
        queued_bytes += len(packet)
        queue.put_nowait(packet)

    async def writer():
        nonlocal queued_bytes
        while True:
            packet = await queue.get()
            await asyncio.to_thread(protocol.write, packet)
            await asyncio.to_thread(protocol.flush)
            queued_bytes -= len(packet)
            queue.task_done()

    bridge = Bridge(emit)
    jobs = set()
    write_task = asyncio.create_task(writer())

    async def handle(message):
        request_id = message.get('id')
        try:
            if not isinstance(request_id, str) or not request_id or len(request_id) > 128 or not isinstance(message.get('args', {}), dict):
                raise Failure('INVALID_REQUEST', 'Invalid Telegram IPC request')
            result = await bridge.operation(message.get('op'), message.get('args', {}))
            emit({'type': 'reply', 'id': request_id, 'ok': True, 'data': result})
        except Exception as exc:
            emit({'type': 'reply', 'id': request_id, 'ok': False, 'error': {'code': getattr(exc, 'code', 'TELEGRAM_SDK_ERROR'), 'message': str(exc) if isinstance(exc, Failure) else f'Telegram SDK operation failed ({type(exc).__name__})'}})

    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline, 512 * 1024 + 1)
            if not line:
                break
            if len(line) > 512 * 1024 or not line.endswith(b'\n') or len(jobs) >= 32:
                raise Failure('BACKPRESSURE', 'Telegram IPC request limit exceeded')
            message = json.loads(line)
            if not isinstance(message, dict):
                raise Failure('INVALID_REQUEST', 'Expected object')
            job = asyncio.create_task(handle(message))
            jobs.add(job)
            job.add_done_callback(jobs.discard)
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        await bridge.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(queue.join(), 1)
        write_task.cancel()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception:
        # Keep credentials, session state and SDK exception text out of stderr.
        sys.stderr.write('Telegram sidecar stopped; check dependencies and configuration.\n')
        sys.exit(1)
