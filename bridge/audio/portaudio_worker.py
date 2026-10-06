"""Isolated raw PCM worker. stdout is JSONL only; callbacks never write pipes.

Device selection uses exact host API + name identities, never default devices.
Playback acknowledgements follow PortAudio DAC time, not enqueue/write success.
"""
import base64
from collections import deque
import json
import math
import queue
import sys
import threading
import time


def device_id(host, name):
    data = json.dumps([host, name], ensure_ascii=False, separators=(",", ":")).encode()
    return "pa:" + base64.urlsafe_b64encode(data).decode().rstrip("=")


def enumerate_devices(sd):
    hosts = sd.query_hostapis()
    result = []
    for index, device in enumerate(sd.query_devices()):
        host = hosts[device["hostapi"]]["name"]
        for direction in ("input", "output"):
            channels = int(device["max_" + direction + "_channels"])
            if channels:
                result.append({"id": device_id(host, device["name"]), "name": device["name"],
                               "hostApi": host, "direction": direction, "channels": channels,
                               "sampleRate": device["default_samplerate"], "backend": "portaudio",
                               "index": index})
    return result


class Worker:
    def __init__(self, sd, config):
        self.sd, self.config = sd, config
        self.rate, self.channels = int(config["sampleRate"]), int(config["channels"])
        self.frame_bytes = self.channels * 2
        self.blocksize = self.rate * int(config["frameMs"]) // 1000
        self.max_bytes = int(config["maxQueueBytes"])
        self.lock = threading.Lock()
        self.events = queue.Queue(maxsize=512)
        self.commands = queue.Queue(maxsize=128)
        self.audio_queue, self.inflight = deque(), deque()
        self.entries = {}
        self.queue_bytes = 0
        self.flush_waiters = []
        self.fatal = None
        self.done = False
        self.input_stream = self.output_stream = None
        self.devices = enumerate_devices(sd)

    def emit(self, value):
        try:
            self.events.put_nowait(value)
        except queue.Full:
            self.fatal = "Audio event queue overflow; consumer is too slow."

    def writer(self):
        while not self.done or not self.events.empty():
            try:
                value = self.events.get(timeout=0.1)
            except queue.Empty:
                continue
            if isinstance(value.get("data"), bytes):
                value["data"] = base64.b64encode(value["data"]).decode("ascii")
            try:
                sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
                sys.stdout.flush()
            except (BrokenPipeError, OSError):
                self.fatal = "Audio parent pipe disconnected."
                return

    def reader(self):
        while not self.done:
            line = sys.stdin.buffer.readline(self.max_bytes * 2 + 8193)
            if not line:
                self.fatal = "Audio parent input closed."
                return
            if len(line) > self.max_bytes * 2 + 8192 or not line.endswith(b"\n"):
                self.fatal = "Audio command exceeds size limit."
                return
            try:
                self.commands.put_nowait(json.loads(line))
            except (queue.Full, ValueError):
                self.fatal = "Audio command queue overflow or invalid JSON."
                return

    def select(self, direction):
        matches = [d for d in self.devices if d["id"] == self.config[direction + "Device"] and d["direction"] == direction]
        if len(matches) != 1:
            raise RuntimeError("Explicit " + direction + " device is missing or ambiguous; no default fallback.")
        if matches[0]["channels"] < self.channels:
            raise RuntimeError("Selected " + direction + " device has too few channels.")
        return matches[0]["index"]

    def input_callback(self, data, frames, timing, status):
        if status:
            self.fatal = "Input audio discontinuity: " + str(status)
            raise self.sd.CallbackAbort
        self.emit({"type": "audio", "data": bytes(data), "sampleRate": self.rate,
                   "channels": self.channels, "encoding": "pcm_s16le"})

    def playback(self, entry, state, evidence="portaudio-dac-clock"):
        self.emit({"type": "playback", "id": entry["id"], "state": state,
                   "playedBytes": entry["played"], "evidence": evidence})

    def finish_flushes(self):
        if not self.entries:
            for request_id in self.flush_waiters:
                self.emit({"type": "ack", "requestId": request_id})
            self.flush_waiters.clear()

    def output_callback(self, output, frames, timing, status):
        output[:] = bytes(len(output))
        if status:
            self.fatal = "Output audio discontinuity: " + str(status)
            raise self.sd.CallbackAbort
        with self.lock:
            current_time = float(timing.currentTime)
            while self.inflight and self.inflight[0][2] <= current_time:
                playback_id, byte_end, _, final = self.inflight.popleft()
                entry = self.entries.get(playback_id)
                if not entry:
                    continue
                entry["played"] = max(entry["played"], byte_end)
                self.playback(entry, "played" if final else "playing")
                if final:
                    del self.entries[playback_id]
            self.finish_flushes()
            cursor = 0
            while self.audio_queue and cursor < len(output):
                dac_time = float(timing.outputBufferDacTime)
                if not math.isfinite(dac_time) or dac_time <= 0 or not math.isfinite(current_time):
                    self.fatal = "Output device did not supply a valid DAC clock; playback cannot be confirmed."
                    raise self.sd.CallbackAbort
                entry = self.audio_queue[0]
                remaining = len(entry["data"]) - entry["offset"]
                size = min(remaining, len(output) - cursor)
                output[cursor:cursor + size] = entry["data"][entry["offset"]:entry["offset"] + size]
                if entry["offset"] == 0:
                    self.playback(entry, "playing", "portaudio-buffer-submitted")
                entry["offset"] += size
                cursor += size
                self.queue_bytes -= size
                final = entry["offset"] == len(entry["data"])
                end_time = dac_time + cursor / self.frame_bytes / self.rate
                self.inflight.append((entry["id"], entry["offset"], end_time, final))
                if final:
                    self.audio_queue.popleft()

    def clear(self):
        # Abort outside the callback lock: PortAudio can wait for an active callback.
        self.output_stream.abort()
        with self.lock:
            for entry in self.entries.values():
                self.playback(entry, "cancelled", "portaudio-abort")
            self.entries.clear()
            self.audio_queue.clear()
            self.inflight.clear()
            self.queue_bytes = 0
            for request_id in self.flush_waiters:
                self.emit({"type": "ack", "requestId": request_id, "error": "Audio flush was cancelled."})
            self.flush_waiters.clear()
        self.output_stream.start()

    def command(self, message):
        command = message.get("type")
        request_id = message.get("requestId")
        try:
            if command == "write":
                if self.flush_waiters:
                    raise RuntimeError("Wait for flush completion before writing more audio.")
                data = base64.b64decode(message["data"], validate=True)
                playback_id = message["id"]
                if not data or len(data) % self.frame_bytes or len(data) > self.max_bytes:
                    raise ValueError("Invalid PCM write size.")
                with self.lock:
                    if playback_id in self.entries or len(self.entries) >= 4096 or self.queue_bytes + len(data) > self.max_bytes:
                        raise RuntimeError("Audio queue full or duplicate playback ID.")
                    entry = {"id": playback_id, "data": data, "offset": 0, "played": 0}
                    self.entries[playback_id] = entry
                    self.audio_queue.append(entry)
                    self.queue_bytes += len(data)
            elif command == "clear":
                self.clear()
            elif command == "flush":
                with self.lock:
                    self.flush_waiters.append(request_id)
                    self.finish_flushes()
                return
            elif command == "stop":
                self.done = True
            else:
                raise ValueError("Unknown audio command.")
            self.emit({"type": "ack", "requestId": request_id})
        except Exception as error:
            self.emit({"type": "ack", "requestId": request_id, "error": str(error)})

    def run(self):
        if sys.byteorder != "little":
            raise RuntimeError("This worker currently requires a little-endian PCM host.")
        if self.config["inputDevice"] == self.config["outputDevice"]:
            raise RuntimeError("Input and output audio routes must be separate.")
        input_index, output_index = self.select("input"), self.select("output")
        self.sd.check_input_settings(device=input_index, channels=self.channels, dtype="int16", samplerate=self.rate)
        self.sd.check_output_settings(device=output_index, channels=self.channels, dtype="int16", samplerate=self.rate)
        writer = threading.Thread(target=self.writer, daemon=True)
        writer.start()
        threading.Thread(target=self.reader, daemon=True).start()
        try:
            self.input_stream = self.sd.RawInputStream(device=input_index, samplerate=self.rate,
                channels=self.channels, dtype="int16", blocksize=self.blocksize, latency="low", callback=self.input_callback)
            self.output_stream = self.sd.RawOutputStream(device=output_index, samplerate=self.rate,
                channels=self.channels, dtype="int16", blocksize=self.blocksize, latency="low", callback=self.output_callback)
            self.output_stream.start()
            self.input_stream.start()
            self.emit({"type": "ready", "inputDevice": self.config["inputDevice"], "outputDevice": self.config["outputDevice"]})
            while not self.done:
                if self.fatal:
                    raise RuntimeError(self.fatal)
                if not self.input_stream.active or not self.output_stream.active:
                    raise RuntimeError("Selected audio device disconnected; no default-device fallback.")
                try:
                    self.command(self.commands.get(timeout=0.05))
                except queue.Empty:
                    pass
        except Exception as error:
            self.emit({"type": "error", "error": str(error)})
            print(str(error), file=sys.stderr)
        finally:
            self.done = True
            for stream in (self.input_stream, self.output_stream):
                if stream is not None:
                    stream.abort()
                    stream.close()
            writer.join(timeout=0.5)


def main():
    try:
        import sounddevice as sd
        if "--list" in sys.argv:
            print(json.dumps({"devices": enumerate_devices(sd), "portaudio": sd.get_portaudio_version()}))
        elif len(sys.argv) == 3 and sys.argv[1] == "--run":
            Worker(sd, json.loads(sys.argv[2])).run()
        else:
            raise RuntimeError("Use --list or --run CONFIG_JSON.")
    except Exception as error:
        print(json.dumps({"type": "error", "error": str(error)}))
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
