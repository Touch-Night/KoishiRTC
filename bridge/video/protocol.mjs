/** Internal raw-video protocol. This is distinct from the public encoded preview frames. */
export const MAX_VIDEO_BYTES = 1920 * 1080 * 4;
export const MAX_VIDEO_METADATA_BYTES = 2048;
export const MAX_VIDEO_PACKET_BYTES = 12 + MAX_VIDEO_METADATA_BYTES + MAX_VIDEO_BYTES;
const magic = Buffer.from('KRV1');

export function videoFormat(config = {}) {
  const width = config.width ?? 640, height = config.height ?? 360;
  const fps = config.fps ?? 15, pixelFormat = config.pixelFormat ?? 'i420';
  if (!Number.isInteger(width) || width < 2 || width > 1920 || !Number.isInteger(height) || height < 2 || height > 1080) throw new Error('Video dimensions must be between 2×2 and 1920×1080.');
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new Error('Video fps must be between 1 and 60.');
  if (!['rgba', 'i420'].includes(pixelFormat)) throw new Error('Raw video pixelFormat must be rgba or i420.');
  if (pixelFormat === 'i420' && (width % 2 || height % 2)) throw new Error('I420 requires even width and height.');
  return Object.freeze({ width, height, fps, pixelFormat });
}

export function videoFrameBytes(format) {
  const { width, height, pixelFormat } = videoFormat(format);
  return width * height * (pixelFormat === 'rgba' ? 4 : 1.5);
}

export function videoIdentifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error(`${name} must be an explicit identifier of 1–256 characters.`);
  return value;
}

export function validateVideoFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new Error('Raw video frame must be an object.');
  for (const field of ['width', 'height', 'fps', 'pixelFormat']) if (frame[field] === undefined) throw new Error(`Raw video frame is missing ${field}.`);
  const format = videoFormat(frame);
  const callId = videoIdentifier(frame.callId, 'callId'), sourceId = videoIdentifier(frame.sourceId, 'sourceId');
  if (!['generated', 'camera', 'screen'].includes(frame.kind)) throw new Error('Video kind must be generated, camera or screen.');
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) throw new Error('Video sequence must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(frame.timestamp) || frame.timestamp < 0) throw new Error('Video timestamp must be integer Unix milliseconds.');
  if (!(frame.data instanceof Uint8Array) || frame.data.byteLength !== videoFrameBytes(format)) throw new Error('Raw video data length does not match its dimensions and pixel format.');
  return { ...format, callId, sourceId, kind: frame.kind, sequence: frame.sequence, timestamp: frame.timestamp, data: frame.data };
}

export function encodeVideoFrame(frame) {
  const { data, ...metadata } = validateVideoFrame(frame);
  const header = Buffer.from(JSON.stringify(metadata));
  if (header.length > MAX_VIDEO_METADATA_BYTES) throw new Error('Video metadata exceeds its limit.');
  const packet = Buffer.allocUnsafe(12 + header.length + data.byteLength);
  magic.copy(packet); packet.writeUInt32BE(header.length, 4); packet.writeUInt32BE(data.byteLength, 8);
  header.copy(packet, 12); packet.set(data, 12 + header.length);
  return packet;
}

export function decodeVideoFrame(input) {
  if (!(input instanceof Uint8Array)) throw new Error('Video packet must contain bytes.');
  const packet = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (packet.length < 12 || packet.length > MAX_VIDEO_PACKET_BYTES || !packet.subarray(0, 4).equals(magic)) throw new Error('Invalid raw video packet header.');
  const headerLength = packet.readUInt32BE(4), dataLength = packet.readUInt32BE(8);
  if (!headerLength || headerLength > MAX_VIDEO_METADATA_BYTES || !dataLength || dataLength > MAX_VIDEO_BYTES || packet.length !== 12 + headerLength + dataLength) throw new Error('Invalid raw video packet lengths.');
  const header = JSON.parse(packet.subarray(12, 12 + headerLength).toString('utf8'));
  return validateVideoFrame({ ...header, data: Buffer.from(packet.subarray(12 + headerLength)) });
}
