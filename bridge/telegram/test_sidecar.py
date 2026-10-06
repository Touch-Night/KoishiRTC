"""Offline bridge regressions. Fake signaling/native SDK never opens an account."""
import asyncio
import base64
import enum
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import sidecar
import media


class Device(enum.IntFlag):
    MICROPHONE = 1
    SPEAKER = 2
    CAMERA = 4
    SCREEN = 8

    @staticmethod
    def to_raw(value):
        return value


class Direction(enum.IntFlag):
    INCOMING = 1
    OUTGOING = 2


class ChatUpdate:
    class Status(enum.IntFlag):
        INCOMING_CALL = 1
        LEFT_CALL = 2
        DISCARDED_CALL = 2
        BUSY_CALL = 4

    def __init__(self, chat_id, status):
        self.chat_id, self.status = chat_id, status


class StreamFrames:
    def __init__(self, chat_id, direction, device, frames):
        self.chat_id, self.direction, self.device, self.frames = chat_id, direction, device, frames


class UpdatedGroupCallParticipant:
    def __init__(self, chat_id):
        self.chat_id = chat_id


class Frame:
    class Info:
        def __init__(self, capture_time=0, width=0, height=0, rotation=0):
            self.capture_time, self.width, self.height, self.rotation = capture_time, width, height, rotation

    def __init__(self, ssrc, frame, info):
        self.ssrc, self.frame, self.info = ssrc, frame, info


class Parameters:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class RawStream:
    def __init__(self, microphone=None, speaker=None, camera=None, screen=None):
        self.microphone, self.speaker, self.camera, self.screen = microphone, speaker, camera, screen


class MediaTrack:
    def __init__(self, media_source, path, parameters):
        self.media_source, self.path, self.parameters = media_source, path, parameters


class RecordStream(RawStream):
    def __init__(self, audio=False, audio_parameters=None, camera=False, screen=False):
        super().__init__(microphone=MediaTrack('external', '', audio_parameters) if audio else None,
                         camera=MediaTrack('external', '', Parameters(width=-1, height=-1, frame_rate=0)) if camera else None,
                         screen=MediaTrack('external', '', Parameters(width=-1, height=-1, frame_rate=0)) if screen else None)


class NotInCallError(Exception):
    pass


class ConnectionNotFound(Exception):
    pass


class FakeClient:
    identity = 123456789
    authorized = True
    connected = True
    instances = []

    def __init__(self, *args, **kwargs):
        self.args, self.kwargs = args, kwargs
        self.session = types.SimpleNamespace(save_entities=True)
        self.disconnected = False
        self.instances.append(self)

    async def connect(self):
        self.connected = True

    async def is_user_authorized(self):
        return self.authorized

    async def get_me(self):
        return types.SimpleNamespace(id=self.identity, bot=False)

    def is_connected(self):
        return self.connected

    async def disconnect(self):
        self.disconnected = True
        self.connected = False

    async def get_entity(self, chat):
        return types.SimpleNamespace(id=chat, bot=False)


class Binding:
    def __init__(self, sdk):
        self.sdk = sdk

    async def calls(self):
        return {chat: {} for chat in self.sdk.native_calls}

    async def set_stream_sources(self, chat, mode, description):
        if chat not in self.sdk.native_calls:
            raise ConnectionNotFound()
        self.sdk.configured.append((chat, mode, description))

    async def stop(self, chat):
        self.sdk.stopped.append(chat)
        if chat not in self.sdk.native_calls:
            raise ConnectionNotFound()
        self.sdk.native_calls.remove(chat)


class FakeSDK:
    def __init__(self, client=None):
        self.client = client
        self.native_calls = set()
        self.played = []
        self.recorded = []
        self.sent = []
        self.left = []
        self.stopped = []
        self.configured = []
        self.dial_count = 0
        self.members = []
        self._binding = Binding(self)
        self._app = types.SimpleNamespace(discard_call=self.discard_call, leave_group_call=self.discard_call)
        self.discarded = []
        self._wait_connect = {}
        self._p2p_configs = {}

    def add_handler(self, handler):
        self.handler = handler

    async def start(self):
        pass

    async def _handle_connection_changed(self, chat, state):
        pass

    async def _join_presentation(self, chat, enabled):
        pass

    def _clear_cache(self, chat):
        self._p2p_configs.pop(chat, None)

    @property
    def calls(self):
        return self._binding.calls()

    async def play(self, chat, stream=None, config=None):
        self.played.append((chat, stream, config))
        if chat not in self.native_calls:
            self.dial_count += 1
            self.native_calls.add(chat)

    async def record(self, chat, stream=None, config=None):
        self.recorded.append((chat, stream))
        if chat not in self.native_calls:
            await self.play(chat, config=config)

    async def leave_call(self, chat):
        self.left.append(chat)
        if chat not in self.native_calls:
            raise NotInCallError()
        self.native_calls.remove(chat)

    async def discard_call(self, chat, *args):
        self.discarded.append(chat)

    async def send_frame(self, chat, device, data, info=None):
        if chat not in self.native_calls:
            raise NotInCallError()
        self.sent.append((chat, device, data, info))

    async def mute(self, chat):
        return True

    async def unmute(self, chat):
        return True

    async def get_participants(self, chat):
        return self.members


fake_types = types.ModuleType('pytgcalls.types')
for name, value in dict(Device=Device, Direction=Direction, ChatUpdate=ChatUpdate, StreamFrames=StreamFrames,
                        UpdatedGroupCallParticipant=UpdatedGroupCallParticipant, Frame=Frame,
                        RecordStream=RecordStream, CallConfig=Parameters, GroupCallConfig=Parameters).items():
    setattr(fake_types, name, value)
fake_raw = types.ModuleType('pytgcalls.types.raw')
for name, value in dict(Stream=RawStream, AudioStream=MediaTrack, AudioParameters=Parameters,
                        VideoStream=MediaTrack, VideoParameters=Parameters).items():
    setattr(fake_raw, name, value)
fake_ntg = types.ModuleType('ntgcalls')
fake_ntg.MediaSource = types.SimpleNamespace(EXTERNAL='external')
fake_ntg.StreamMode = types.SimpleNamespace(CAPTURE='capture', PLAYBACK='playback')
fake_ntg.ConnectionState = types.SimpleNamespace(CONNECTED='connected', CONNECTING='connecting', FAILED='failed')
fake_ntg.ConnectionKind = types.SimpleNamespace(NORMAL='normal', PRESENTATION='presentation')
fake_ntg.ConnectionNotFound = ConnectionNotFound
fake_tg = types.ModuleType('pytgcalls')
fake_tg.PyTgCalls, fake_tg.types = FakeSDK, fake_types
fake_session = types.ModuleType('pytgcalls.pytgcalls_session')
fake_session.PyTgCallsSession = type('PyTgCallsSession', (), {'notice_displayed': False})
fake_errors = types.ModuleType('pytgcalls.exceptions')
fake_errors.NotInCallError = NotInCallError
fake_telethon = types.ModuleType('telethon')
fake_telethon.TelegramClient = FakeClient
fake_stream_params = types.ModuleType('pytgcalls.methods.utilities.stream_params')


class StreamParams:
    @staticmethod
    async def get_stream_params(stream):
        return stream

    get_record_params = get_stream_params


fake_stream_params.StreamParams = StreamParams


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.modules = patch.dict(sys.modules, {'pytgcalls': fake_tg, 'pytgcalls.types': fake_types,
            'pytgcalls.types.raw': fake_raw, 'ntgcalls': fake_ntg, 'telethon': fake_telethon,
            'pytgcalls.pytgcalls_session': fake_session, 'pytgcalls.exceptions': fake_errors,
            'pytgcalls.methods.utilities.stream_params': fake_stream_params})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.events = []
        self.bridge = sidecar.Bridge(lambda value, **kwargs: self.events.append(value))
        self.bridge.provider_id, self.bridge.self_id = 'telegram', '123456789'
        self.bridge.allowed = {'234567890', '-1001234567890'}
        self.bridge.types, self.bridge.sdk, self.bridge.client = fake_types, FakeSDK(), FakeClient()
        self.addAsyncCleanup(self.bridge.close)

    def connected(self, chat=234567890):
        call = self.bridge.new_call(chat, 'outgoing', 'connected')
        self.bridge.sdk.native_calls.add(chat)
        return call

    async def operation(self, call, op, **args):
        return await self.bridge.operation(op, dict(callId=call['snapshot']['id'], **args))

    async def test_start_uses_local_schema_and_existing_session_without_interactive_start(self):
        self.bridge.sdk = None
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'account.session').touch()
            config = dict(apiId=12345, apiHash='a' * 32, selfId='123456789', sessionPath=str(path / 'account.session'))
            (path / 'config.json').write_text(json.dumps(config))
            versions = {'py-tgcalls': '3.0.0', 'ntgcalls': '3.0.1', 'Telethon': '1.45.0', 'Pillow': '12.3.0'}
            with patch('importlib.metadata.version', side_effect=versions.__getitem__):
                result = await self.bridge.start(dict(providerId='telegram', selfId='123456789', configPath=str(path / 'config.json'), allowedChatIds=['234567890']))
            self.assertEqual(result['selfId'], '123456789')
            self.assertEqual(self.bridge.client.args, (config['sessionPath'], config['apiId'], config['apiHash']))
            self.assertFalse(self.bridge.client.kwargs['auto_reconnect'])
            self.assertFalse(self.bridge.sdk.native_calls)

    async def test_incoming_allowlist_ring_accept_and_hangup(self):
        await self.bridge.update(None, ChatUpdate(999, ChatUpdate.Status.INCOMING_CALL))
        self.assertIsNone(self.bridge.active)
        await self.bridge.update(None, ChatUpdate(234567890, ChatUpdate.Status.INCOMING_CALL))
        call = self.bridge.active
        self.assertEqual(call['snapshot']['state'], 'ringing')
        self.assertFalse(self.bridge.sdk.played)
        await self.operation(call, 'accept')
        await call['task']
        self.assertEqual(call['snapshot']['state'], 'connected')
        capture = self.bridge.sdk.played[0][1]
        self.assertEqual(capture.microphone.media_source, 'external')
        self.assertIsNone(capture.camera)
        self.assertIsNone(capture.screen)
        await self.operation(call, 'hangup')
        self.assertEqual(call['snapshot']['state'], 'ended')
        self.assertFalse(self.bridge.sdk.native_calls)

    async def test_audio_accepts_exact_10ms_stereo_and_mute_rejects_input(self):
        call = self.connected()
        for size in (0, 960, 1919, 1921, 3840):
            with self.assertRaises(sidecar.Failure):
                await self.operation(call, 'audio.write', data=base64.b64encode(bytes(size)).decode())
        self.assertFalse(self.bridge.sdk.sent)
        result = await self.operation(call, 'audio.write', data=base64.b64encode(bytes(1920)).decode())
        self.assertEqual(result, {'submittedBytes': 1920})
        self.assertEqual(self.bridge.sdk.sent[-1][:3], (234567890, Device.MICROPHONE, bytes(1920)))
        await self.operation(call, 'mute', muted=True)
        with self.assertRaises(sidecar.Failure):
            await self.operation(call, 'audio.write', data=base64.b64encode(bytes(1920)).decode())

    async def test_video_sources_require_explicit_external_selection(self):
        call = self.connected()
        for args in [dict(kind='camera', sourceId='device:default'), dict(kind='screen', sourceId='external-frames', framing='full'), dict(kind='camera', sourceId='external-frames', framing='bad')]:
            with self.assertRaises(sidecar.Failure):
                await self.operation(call, 'video.send', **args)
        self.assertFalse(call['sending'])
        result = await self.operation(call, 'video.send', kind='camera', sourceId='external-frames', framing='portrait-safe')
        self.assertEqual(result['sending']['camera']['framing'], 'portrait-safe')
        self.assertEqual(result['sending']['camera']['state'], 'sending')
        self.assertFalse(self.bridge.sdk.sent)
        with patch.object(sidecar, 'jpeg_to_i420', return_value=(bytes(345600), 640, 360)):
            result = await self.operation(call, 'video.write', kind='camera', sequence=0, width=1, height=1, data=base64.b64encode(b'jpeg').decode())
            self.assertEqual(result['state'], 'submitted')
            self.assertEqual(self.bridge.sdk.sent[-1][1], Device.CAMERA)
            with self.assertRaises(sidecar.Failure):
                await self.operation(call, 'video.write', kind='camera', sequence=0, width=1, height=1, data=base64.b64encode(b'jpeg').decode())
        await self.operation(call, 'video.stop', kind='camera')
        self.assertFalse(call['sending'])

    async def test_received_video_requires_subscription_and_keeps_decoded_evidence(self):
        call = self.connected()
        frame = Frame(99, bytes(6), Frame.Info(width=2, height=2, rotation=90))
        update = StreamFrames(234567890, Direction.INCOMING, Device.CAMERA, [frame])
        with patch.object(sidecar, 'i420_to_jpeg', return_value=(b'jpeg', 2, 2)) as convert:
            await self.bridge.update(None, update)
            convert.assert_not_called()
            track = await self.operation(call, 'video.subscribe', participantId='234567890', kind='camera')
            await self.bridge.update(None, update)
            convert.assert_called_once_with(bytes(6), 2, 2, 90)
        event = [event for event in self.events if event['type'] == 'video'][0]['frame']
        self.assertEqual(event['evidence'], sidecar.EVIDENCE)
        self.assertEqual(event['participantId'], '234567890')
        self.assertTrue(track['hasFrame'])
        self.assertIsNone(track['firstFrameAt'])
        self.assertIsNotNone(track['decodedFrameAt'])

    async def test_inflight_decode_is_discarded_after_call_ends(self):
        call = self.connected()
        await self.operation(call, 'video.subscribe', participantId='234567890', kind='camera')
        entered, release = asyncio.Event(), asyncio.Event()
        async def convert(*args):
            entered.set()
            await release.wait()
            return b'jpeg', 2, 2
        update = StreamFrames(234567890, Direction.INCOMING, Device.CAMERA, [Frame(1, bytes(6), Frame.Info(width=2, height=2))])
        with patch.object(sidecar.asyncio, 'to_thread', side_effect=convert):
            task = asyncio.create_task(self.bridge.update(None, update))
            await entered.wait()
            self.bridge.finish(call, 'ended')
            release.set()
            await task
        self.assertFalse([event for event in self.events if event['type'] == 'video'])

    async def test_group_ssrc_routes_only_subscribed_current_member(self):
        call = self.connected(-1001234567890)
        source = types.SimpleNamespace(sources=[types.SimpleNamespace(ssrcs=[0xffffffff])])
        self.bridge.sdk.members = [types.SimpleNamespace(user_id=234567890, video_info=source, presentation_info=None)]
        await self.bridge.refresh_members(call)
        await self.operation(call, 'video.subscribe', participantId='234567890', kind='camera')
        update = StreamFrames(call['chat'], Direction.INCOMING, Device.CAMERA, [Frame(-1, bytes(6), Frame.Info(width=2, height=2))])
        with patch.object(sidecar, 'i420_to_jpeg', return_value=(b'jpeg', 2, 2)):
            await self.bridge.update(None, update)
        self.assertEqual([x for x in self.events if x['type'] == 'video'][0]['frame']['participantId'], '234567890')
        self.bridge.sdk.members = []
        await self.bridge.refresh_members(call)
        self.assertFalse(call['tracks'])
        self.assertFalse(call['ssrc'])

    async def test_video_reconfiguration_never_redials_a_disappeared_native_call(self):
        call = self.connected()
        self.bridge.sdk.native_calls.clear()
        with self.assertRaises(Exception):
            await self.operation(call, 'video.send', kind='camera', sourceId='external-frames')
        self.assertEqual(self.bridge.sdk.dial_count, 0)

    async def test_subscribe_never_redials_a_disappeared_native_call(self):
        call = self.connected()
        self.bridge.sdk.native_calls.clear()
        with self.assertRaises(Exception):
            await self.operation(call, 'video.subscribe', participantId='234567890', kind='camera')
        self.assertEqual(self.bridge.sdk.dial_count, 0)

    async def test_hangup_of_already_absent_native_call_finishes(self):
        call = self.connected()
        self.bridge.sdk.native_calls.clear()
        await self.operation(call, 'hangup')
        self.assertIn(call['snapshot']['state'], sidecar.TERMINAL)

    async def test_close_releases_native_call_even_after_public_failure(self):
        call = self.connected()
        self.bridge.finish(call, 'failed', 'lost signaling')
        await self.bridge.close()
        self.assertFalse(self.bridge.sdk.native_calls)
        self.assertTrue(self.bridge.client.disconnected)

    async def test_uncertain_signaling_cleanup_blocks_new_dial_and_is_idempotent(self):
        call = self.connected()
        async def fail(*args):
            raise RuntimeError('private-upstream-error')
        self.bridge.sdk._app.discard_call = fail
        with self.assertRaises(sidecar.Failure) as error:
            await self.operation(call, 'hangup')
        self.assertEqual(error.exception.code, 'RESULT_UNKNOWN')
        self.assertEqual(call['snapshot']['state'], 'failed')
        self.assertFalse(self.bridge.sdk.native_calls)
        with self.assertRaises(sidecar.Failure) as error:
            await self.bridge.operation('dial', dict(kind='direct', targetId='234567890'))
        self.assertEqual(error.exception.code, 'RESULT_UNKNOWN')
        await self.bridge.terminate(call)
        self.assertEqual(self.bridge.sdk.stopped, [call['chat']])

    async def test_reject_pending_invitation_discards_signaling_without_native_call(self):
        call = self.bridge.new_call(234567890, 'incoming', 'ringing')
        wait = asyncio.get_running_loop().create_future()
        self.bridge.sdk._p2p_configs[call['chat']] = types.SimpleNamespace(wait_data=wait)
        await self.operation(call, 'reject')
        self.assertEqual(call['snapshot']['state'], 'ended')
        self.assertEqual(self.bridge.sdk.discarded, [call['chat']])
        self.assertTrue(wait.cancelled())
        self.assertFalse(self.bridge.sdk._p2p_configs)

    async def test_watch_native_query_failure_marks_offline_and_stops_media(self):
        call = self.connected()
        async def fail():
            raise RuntimeError('private-native-error')
        async def tick(*args):
            return None
        self.bridge.sdk._binding.calls = fail
        with patch.object(sidecar.asyncio, 'sleep', side_effect=tick):
            await self.bridge.watch()
        self.assertEqual(call['snapshot']['state'], 'failed')
        self.assertFalse(self.bridge.sdk.native_calls)
        self.assertTrue(self.bridge.stopping)
        self.assertTrue(any(event['type'] == 'offline' for event in self.events))

    async def test_watch_signaling_disconnect_stops_native_even_when_discard_fails(self):
        call = self.connected()
        self.bridge.client.connected = False
        async def fail(*args):
            raise ConnectionError()
        async def tick(*args):
            return None
        self.bridge.sdk._app.discard_call = fail
        with patch.object(sidecar.asyncio, 'sleep', side_effect=tick):
            await self.bridge.watch()
        self.assertFalse(self.bridge.sdk.native_calls)
        self.assertTrue(self.bridge.cleanup_unknown)
        self.assertEqual(call['snapshot']['state'], 'failed')

    async def test_hangup_cancels_connect_task_before_cleaning_native_and_signaling(self):
        call = self.connected()
        entered = asyncio.Event()
        async def connecting():
            entered.set()
            await asyncio.Event().wait()
        call['task'] = asyncio.create_task(connecting())
        await entered.wait()
        await self.operation(call, 'hangup')
        self.assertTrue(call['task'].cancelled())
        self.assertFalse(self.bridge.sdk.native_calls)
        self.assertEqual(self.bridge.sdk.discarded, [call['chat']])

    async def test_cleanup_stops_native_without_waiting_for_stalled_media_lock(self):
        call = self.connected()
        await self.bridge.media_lock.acquire()
        try:
            await asyncio.wait_for(self.operation(call, 'hangup'), 0.5)
        finally:
            self.bridge.media_lock.release()
        self.assertFalse(self.bridge.sdk.native_calls)

    def test_null_writer_does_not_accumulate_upstream_prints(self):
        writer = sidecar.NullWriter()
        self.assertEqual(writer.write('x' * 100000), 100000)
        self.assertFalse(writer.isatty())
        self.assertFalse(vars(writer))


    async def test_private_second_video_channel_is_rejected_but_group_allows_both(self):
        call = self.connected()
        await self.operation(call, 'video.send', kind='camera', sourceId='external-frames')
        with self.assertRaises(sidecar.Failure) as result:
            await self.operation(call, 'video.send', kind='screen', sourceId='external-frames')
        self.assertEqual(result.exception.code, 'UNSUPPORTED_VIDEO_COMBINATION')
        self.assertNotIn('screen', call['sending'])
        await self.bridge.terminate(call)
        group = self.connected(-1001234567890)
        for kind in ('camera', 'screen'):
            await self.operation(group, 'video.send', kind=kind, sourceId='external-frames')
        self.assertEqual(set(group['sending']), {'camera', 'screen'})

    async def test_pending_screen_handshake_does_not_block_audio_submission(self):
        call = self.connected(-1001234567890)
        entered, resume = asyncio.Event(), asyncio.Event()
        async def presentation(chat, enabled):
            entered.set()
            await resume.wait()
        self.bridge.sdk._join_presentation = presentation
        sending = asyncio.create_task(self.operation(call, 'video.send', kind='screen', sourceId='external-frames'))
        await entered.wait()
        try:
            result = await asyncio.wait_for(self.operation(call, 'audio.write', data=base64.b64encode(bytes(1920)).decode()), 1)
            self.assertEqual(result['submittedBytes'], 1920)
        finally:
            resume.set()
            await sending

    async def test_fresh_session_resolves_only_selected_existing_dialog(self):
        async def missing(chat):
            raise ValueError('missing access hash')
        seen = []
        async def dialogs(limit):
            self.assertEqual(limit, 500)
            for chat in (999, 234567890, 888):
                seen.append(chat)
                yield types.SimpleNamespace(id=chat, entity=types.SimpleNamespace(id=chat, bot=False))
        self.bridge.client.get_entity = missing
        self.bridge.client.iter_dialogs = dialogs
        result = await self.bridge.operation('dial', {'kind':'direct', 'targetId':'234567890'})
        self.assertEqual(result['targetId'], '234567890')
        self.assertEqual(seen, [999,234567890])


class MediaTests(unittest.TestCase):
    def test_pcm_mixing_is_little_endian_bounded_and_rejects_partial_stereo(self):
        self.assertEqual(media.mix_pcm([b'\xe8\x03' * 2, b'\x18\xfc' * 2]), bytes(4))
        self.assertEqual(media.mix_pcm([b'x', b'xx', bytes(192004)]), b'')
        self.assertEqual(media.mix_pcm([b'\xff\x7f' * 2] * 64), b'\xff\x7f' * 2)

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow not installed; run Telegram setup for image codec tests')
    def test_jpeg_i420_roundtrip_dimensions_rotation_and_safe_frame(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new('RGB', (320, 180), 'red').save(output, 'JPEG')
        encoded = output.getvalue()
        raw, width, height = media.jpeg_to_i420(encoded, 320, 180)
        self.assertEqual((len(raw), width, height), (345600, 640, 360))
        back, width, height = media.i420_to_jpeg(raw, width, height)
        with Image.open(io.BytesIO(back)) as image:
            red, green, blue = image.getpixel((320, 180))
            self.assertGreater(red, 245)
            self.assertLess(max(green, blue), 10)
        safe, _, _ = media.jpeg_to_i420(encoded, 320, 180, 'portrait-safe')
        self.assertEqual(safe[180 * 640], 16)
        self.assertGreater(safe[180 * 640 + 320], 40)
        _, rotated_w, rotated_h = media.i420_to_jpeg(raw, 640, 360, 90)
        self.assertEqual((rotated_w, rotated_h), (360, 640))
        with self.assertRaises(ValueError): media.jpeg_to_i420(encoded, 319, 180)
        with self.assertRaises(ValueError): media.i420_to_jpeg(raw[:-1], 640, 360)


@unittest.skipUnless(importlib.util.find_spec('pytgcalls') and importlib.util.find_spec('ntgcalls'),
                     'Pinned Telegram SDK not installed; run setup for native API checks')
class InstalledSdkTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_local_native_external_submission_and_private_channel_limit(self):
        # Pure native object without MTProto client, signaling, or a remote peer.
        # Every source is EXTERNAL; no physical audio/video device is opened.
        from ntgcalls import NTgCalls, StreamMode, StreamDevice, MediaSource, FrameData, VideoRotation, InvalidParams
        from pytgcalls.types.raw import Stream, AudioStream, AudioParameters, VideoStream, VideoParameters
        from pytgcalls.methods.utilities.stream_params import StreamParams
        binding = NTgCalls()
        await binding.create_p2p_call(42)
        try:
            audio = AudioStream(MediaSource.EXTERNAL, '', AudioParameters(bitrate=48000, channels=2))
            video = VideoStream(MediaSource.EXTERNAL, '', VideoParameters(width=640, height=360, frame_rate=15))
            description = await StreamParams.get_stream_params(Stream(microphone=audio, camera=video))
            await binding.set_stream_sources(42, StreamMode.CAPTURE, description)
            await binding.set_stream_sources(42, StreamMode.PLAYBACK, description)
            await binding.send_external_frame(42, StreamDevice.MICROPHONE, bytes(1920), FrameData(0, VideoRotation.VIDEO_ROTATION_0, 0, 0))
            await binding.send_external_frame(42, StreamDevice.CAMERA, bytes([16]) * 230400 + bytes([128]) * 115200, FrameData(1, VideoRotation.VIDEO_ROTATION_0, 640, 360))
            with self.assertRaises(InvalidParams):
                await binding.set_stream_sources(42, StreamMode.CAPTURE, await StreamParams.get_stream_params(Stream(microphone=audio, camera=video, screen=video)))
        finally:
            await binding.stop(42)
        self.assertEqual(await binding.calls(), {})

    async def test_actual_native_reconfigure_missing_call_fails_without_dialing(self):
        # Imports, parameter conversion and an empty native engine only. No
        # TelegramClient/PyTgCalls instance, account or network API is started.
        import gc
        from ntgcalls import ConnectionNotFound, MediaSource, NTgCalls
        from pytgcalls import types as installed_types
        bridge = sidecar.Bridge(lambda *args, **kwargs: None)
        bridge.types = installed_types
        binding = NTgCalls()
        bridge.sdk = types.SimpleNamespace(_binding=binding)
        call = bridge.new_call(234567890, 'outgoing', 'connected')
        capture = bridge.capture(call)
        self.assertEqual(capture.microphone.media_source, MediaSource.EXTERNAL)
        self.assertEqual(capture.microphone.parameters.bitrate, 48000)
        self.assertEqual(capture.microphone.parameters.channels, 2)
        try:
            with self.assertRaises(ConnectionNotFound):
                await bridge.configure(call, capture)
            with self.assertRaises(ConnectionNotFound):
                await bridge.record(call)
            self.assertEqual(await binding.calls(), {})
        finally:
            bridge.sdk = None
            del binding
            gc.collect()


if __name__ == '__main__':
    unittest.main(verbosity=2)
