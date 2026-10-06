"""Bounded, device-free PCM/I420/JPEG conversion for the Telegram sidecar."""
import array
import io
import sys

MAX_JPEG = 256 * 1024
MAX_PIXELS = 2073600


def mix_pcm(frames):
    """Mix simultaneous 48 kHz stereo S16LE frames, clipping after averaging."""
    values = []
    for data in frames:
        if not data or len(data) % 4 or len(data) > 192000:
            continue
        samples = array.array('h', data)
        if sys.byteorder != 'little':
            samples.byteswap()
        values.append(samples)
    if not values:
        return b''
    count = max(map(len, values))
    result = array.array('h', (max(-32768, min(32767, sum(v[i] for v in values if i < len(v)) // len(values))) for i in range(count)))
    if sys.byteorder != 'little':
        result.byteswap()
    return result.tobytes()


def dimensions(width, height):
    if type(width) is not int or type(height) is not int or min(width, height) < 1 or max(width, height) > 4096 or width * height > MAX_PIXELS:
        raise ValueError('Invalid video dimensions')


def jpeg_to_i420(data, width, height, framing='full'):
    from PIL import Image, ImageOps
    dimensions(width, height)
    if len(data) < 4 or len(data) > MAX_JPEG or data[:2] != b'\xff\xd8' or data[-2:] != b'\xff\xd9':
        raise ValueError('Invalid JPEG')
    with Image.open(io.BytesIO(data)) as image:
        if image.format != 'JPEG' or image.size != (width, height):
            raise ValueError('JPEG dimensions do not match')
        image.load()
        # The NTgCalls sender uses contiguous even-size I420. Use a fixed canvas
        # so changing the consumer's JPEG dimensions does not recreate capture.
        size = (640, 360)
        content_size = (202, 360) if framing == 'portrait-safe' else size
        fitted = ImageOps.contain(image.convert('RGB'), content_size)
        canvas = Image.new('RGB', size)
        canvas.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
        y, u, v = canvas.convert('YCbCr').split()
        y = y.point([round(16 + x * 219 / 255) for x in range(256)])
        uv = [max(0, min(255, round(128 + (x - 128) * 224 / 255))) for x in range(256)]
        result = y.tobytes() + u.resize((320, 180), Image.Resampling.BOX).point(uv).tobytes() + v.resize((320, 180), Image.Resampling.BOX).point(uv).tobytes()
        return result, *size


def i420_to_jpeg(data, width, height, rotation=0):
    from PIL import Image
    dimensions(width, height)
    cw, ch = (width + 1) // 2, (height + 1) // 2
    y_size, uv_size = width * height, cw * ch
    if len(data) != y_size + uv_size * 2:
        raise ValueError('Invalid I420 length')
    y = Image.frombytes('L', (width, height), data[:y_size]).point([max(0, min(255, round((x - 16) * 255 / 219))) for x in range(256)])
    uv = [max(0, min(255, round(128 + (x - 128) * 255 / 224))) for x in range(256)]
    u = Image.frombytes('L', (cw, ch), data[y_size:y_size + uv_size]).resize((width, height), Image.Resampling.BILINEAR).point(uv)
    v = Image.frombytes('L', (cw, ch), data[y_size + uv_size:]).resize((width, height), Image.Resampling.BILINEAR).point(uv)
    image = Image.merge('YCbCr', (y, u, v)).convert('RGB')
    if rotation in (90, 180, 270):
        image = image.rotate(-rotation, expand=True)
    image.thumbnail((1280, 720))
    for quality in (80, 65, 45, 25):
        output = io.BytesIO()
        image.save(output, 'JPEG', quality=quality)
        if output.tell() <= MAX_JPEG:
            return output.getvalue(), image.width, image.height
    raise ValueError('Encoded frame exceeds JPEG limit')
