"""Raw generated/external frames -> an explicit existing virtual camera; never capture."""
import importlib.util
import json
import os
import queue
import struct
import sys
import threading
import time


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def validate_config(config, platform=None):
    platform = platform or sys.platform
    allowed = {"linux": ("v4l2loopback",), "win32": ("obs", "unitycapture"), "darwin": ("obs",)}
    backend, device = config.get("backend"), config.get("device")
    if backend not in allowed.get(platform, ()):
        raise ValueError("An explicit supported virtual-camera backend is required")
    if not isinstance(device, str) or not device.strip() or device.lower() in ("auto", "default") or len(device) > 256:
        raise ValueError("An explicit virtual-camera device is required")
    if backend == "obs" and device != "OBS Virtual Camera":
        raise ValueError("OBS requires the exact device name OBS Virtual Camera")
    if backend == "v4l2loopback" and (not device.startswith("/dev/video") or not device[10:].isdigit()):
        raise ValueError("An explicit /dev/videoN path is required")
    w, h, fps = config.get("width"), config.get("height"), config.get("fps")
    if type(w) is not int or type(h) is not int or not (2 <= w <= 1920 and 2 <= h <= 1080):
        raise ValueError("Invalid frame dimensions")
    if type(fps) not in (int, float) or not (1 <= fps <= 60):
        raise ValueError("Invalid frame rate")
    if config.get("pixelFormat") not in ("i420", "rgba") or ((config["pixelFormat"] == "i420" or backend == "v4l2loopback") and (w % 2 or h % 2)):
        raise ValueError("Invalid raw frame format")
    for field in ("callId", "sourceId"):
        if not isinstance(config.get(field), str) or not config[field].strip() or len(config[field]) > 256:
            raise ValueError("An explicit " + field + " is required")
    if "qqDeviceId" in config and (not isinstance(config["qqDeviceId"], str) or not config["qqDeviceId"].strip() or len(config["qqDeviceId"]) > 256):
        raise ValueError("Invalid explicit QQ virtual-camera device ID")
    return w * h * 4 if config["pixelFormat"] == "rgba" else w * h * 3 // 2


def verify_loopback(device):
    # QUERYCAP only: prove this path is a loopback output, never start a physical capture.
    import fcntl
    fd = os.open(device, os.O_WRONLY | os.O_NONBLOCK)
    try:
        cap = bytearray(104)
        fcntl.ioctl(fd, 0x80685600, cap, True)  # VIDIOC_QUERYCAP
        driver = bytes(cap[:16]).split(b"\0", 1)[0]
        if driver not in (b"v4l2 loopback", b"v4l2loopback"):
            raise ValueError("Selected device is not a v4l2loopback virtual camera")
        # QQ's camera enumeration uses V4L2 bus_info, not the /dev/videoN path.
        bus_info = bytes(cap[48:80]).split(b"\0", 1)[0].decode("utf-8", errors="strict")
        if not bus_info:
            raise ValueError("Virtual camera has no stable V4L2 bus_info identifier")
        return bus_info
    finally:
        os.close(fd)


def read_exact(stream, length, allow_eof=False):
    result = bytearray()
    while len(result) < length:
        chunk = stream.read(length - len(result))
        if not chunk:
            if allow_eof and not result:
                return None
            raise ValueError("Truncated raw video packet")
        result.extend(chunk)
    return result


def read_frame(stream, config, size, last_sequence):
    prefix = read_exact(stream, 12, allow_eof=True)
    if prefix is None:
        return None
    magic, header_len, data_len = struct.unpack(">4sII", prefix)
    if magic != b"KRV1" or not 1 <= header_len <= 2048 or data_len != size:
        raise ValueError("Invalid raw video packet header")
    metadata = json.loads(read_exact(stream, header_len))
    if not isinstance(metadata, dict):
        raise ValueError("Invalid video metadata")
    for field in ("width", "height", "fps", "pixelFormat", "callId", "sourceId"):
        if metadata.get(field) != config[field]:
            raise ValueError("Frame does not match the selected virtual-camera session")
    sequence, timestamp = metadata.get("sequence"), metadata.get("timestamp")
    if type(sequence) is not int or not last_sequence < sequence <= 9007199254740991:
        raise ValueError("Frame sequence must increase")
    if type(timestamp) is not int or not 0 <= timestamp <= 9007199254740991:
        raise ValueError("Invalid frame timestamp")
    if metadata.get("kind") not in ("generated", "camera", "screen"):
        raise ValueError("Invalid frame kind")
    return metadata, read_exact(stream, data_len)


def to_nv12(frame, width, height, pixel_format):
    """Contiguous Y + interleaved U,V; RGBA uses BT.601 limited-range 4:2:0.

    Input remains raw RGBA or I420. Use int32 before sums/products to avoid
    uint8/int16 overflow. Chroma averages RGB over each 2x2 block before its
    limited-range transform; alpha is discarded, as in the previous RGB path.
    """
    import numpy as np
    if width % 2 or height % 2 or width < 2 or height < 2:
        raise ValueError("NV12 output requires even dimensions")
    pixels = width * height
    expected = pixels * 4 if pixel_format == "rgba" else pixels * 3 // 2
    if pixel_format not in ("rgba", "i420") or frame.dtype != np.uint8 or frame.ndim != 1 or frame.size != expected:
        raise ValueError("Invalid NV12 conversion input")
    result = np.empty(pixels * 3 // 2, dtype=np.uint8)
    if pixel_format == "i420":
        # Preserve luma and chroma samples exactly; only U/V storage changes.
        result[:pixels] = frame[:pixels]
        result[pixels::2] = frame[pixels:pixels + pixels // 4]
        result[pixels + 1::2] = frame[pixels + pixels // 4:]
        return result
    rgb = frame.reshape(height, width, 4)[:, :, :3].astype(np.int32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16
    result[:pixels] = np.clip(y, 16, 235).reshape(-1)
    # Centered 2x2 box filtering, rounded once (never nearest-neighbor UV).
    chroma = (rgb[0::2, 0::2] + rgb[0::2, 1::2] + rgb[1::2, 0::2] + rgb[1::2, 1::2] + 2) >> 2
    r, g, b = chroma[:, :, 0], chroma[:, :, 1], chroma[:, :, 2]
    u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128
    v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128
    result[pixels::2] = np.clip(u, 16, 240).reshape(-1)
    result[pixels + 1::2] = np.clip(v, 16, 240).reshape(-1)
    return result


def send_frames(camera, config, size, convert_nv12, np):
    """Clock the device even when an upstream static source sends no new frames.

    Only new packets get a receipt. The reader applies pipe backpressure after
    two queued packets; it never collects an unbounded list of pending frames.
    EOF/errors follow already read packets, then stop repeats and close camera.
    """
    packets = queue.Queue(maxsize=2)
    stopped = threading.Event()
    # A daemon blocked in BufferedReader.read can hold its shutdown lock. Read
    # the underlying raw pipe instead; read_exact already handles short reads.
    stream = getattr(sys.stdin.buffer, "raw", sys.stdin.buffer)

    def enqueue(item):
        while not stopped.is_set():
            try:
                packets.put(item, timeout=0.1)
                return True
            except queue.Full:
                pass
        return False

    def read_packets():
        sequence = -1
        try:
            while not stopped.is_set():
                packet = read_frame(stream, config, size, sequence)
                if packet is None:
                    enqueue(("eof", None))
                    return
                sequence = packet[0]["sequence"]
                if not enqueue(("frame", packet)):
                    return
        except Exception as error:
            enqueue(("error", error))

    reader = threading.Thread(target=read_packets, name="virtual-camera-input", daemon=True)
    reader.start()
    period, next_tick, frame = 1.0 / config["fps"], time.monotonic(), None
    try:
        while True:
            try:
                kind, packet = packets.get(timeout=max(0, next_tick - time.monotonic()) if frame is not None else None)
            except queue.Empty:
                kind, packet = "repeat", None
            if kind == "eof":
                return
            if kind == "error":
                raise packet
            if kind == "frame":
                # A new packet can arrive before the next tick. Keep its place
                # in the clock rather than bursting writes at input speed.
                stopped.wait(max(0, next_tick - time.monotonic()))
                metadata, raw = packet
                frame = np.frombuffer(raw, dtype=np.uint8)
                if convert_nv12:
                    frame = to_nv12(frame, config["width"], config["height"], config["pixelFormat"])
                elif config["pixelFormat"] == "rgba":
                    frame = frame.reshape(config["height"], config["width"], 4)
            camera.send(frame)
            if kind == "frame":
                emit({"type": "submitted", "sequence": metadata["sequence"], "bytes": size, "evidence": "pyvirtualcam-send"})
            next_tick += period
            now = time.monotonic()
            if next_tick <= now:
                next_tick = now + period  # Do not burst to catch up after a slow send.
    finally:
        stopped.set()
        # Raw pipe reads cannot be cancelled portably; a remaining blocked
        # daemon owns no device or output, and exits with the worker process.
        reader.join(timeout=0.15)


def run(config):
    size = validate_config(config)
    native_device_id = config.get("qqDeviceId") or config["device"]
    if config["backend"] == "v4l2loopback":
        native_device_id = verify_loopback(config["device"])
    import numpy as np
    import pyvirtualcam
    # RGB inputs are internally converted to I420 by pyvirtualcam. This QQ
    # build lacks its I420 capture shader, so choose its available NV12 path
    # explicitly instead. Other OS backends keep their existing input format.
    convert_nv12 = config["backend"] == "v4l2loopback"
    output_format = "nv12" if convert_nv12 else config["pixelFormat"]
    fmt = getattr(pyvirtualcam.PixelFormat, output_format.upper())
    with pyvirtualcam.Camera(width=config["width"], height=config["height"], fps=config["fps"], fmt=fmt,
                             backend=config["backend"], device=config["device"]) as camera:
        if camera.device != config["device"] or camera.backend != config["backend"]:
            raise ValueError("Virtual camera selected a different device or backend")
        if convert_nv12 and camera.native_fmt != pyvirtualcam.PixelFormat.NV12:
            raise ValueError("Virtual-camera backend did not select native NV12")
        emit({"type": "ready", **{key: config[key] for key in ("device", "backend", "width", "height", "fps", "pixelFormat")},
              "outputPixelFormat": output_format, "conversion": config["pixelFormat"] + "-to-nv12" if convert_nv12 else "none",
              **({"nativePixelFormat": "nv12", "colorSpace": "bt601-limited" if config["pixelFormat"] == "rgba" else "input-i420"} if convert_nv12 else {}),
              "nativeDeviceId": native_device_id})
        send_frames(camera, config, size, convert_nv12, np)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--diagnostics"]:
            modules = {name: importlib.util.find_spec(name) is not None for name in ("numpy", "pyvirtualcam")}
            emit({"available": all(modules.values()), "modules": modules, "platform": sys.platform, "opensDevices": False})
        elif len(sys.argv) == 3 and sys.argv[1] == "--run":
            run(json.loads(sys.argv[2]))
        else:
            raise ValueError("Use --diagnostics or --run with explicit JSON configuration")
    except Exception as error:
        emit({"type": "error", "error": str(error)})
        sys.exit(1)
