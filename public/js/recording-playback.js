// Playback-only WebM metadata repair. Stored evidence is never rewritten.
import { MAX_AUDIO_B64, blobToDataUrl } from './exam-audio.js';

function vint(bytes, start, id = false) {
  const first = bytes[start];
  let length = 1;
  while (length <= 8 && !(first & (1 << (8 - length)))) length++;
  if (length > (id ? 4 : 8) || start + length > bytes.length) throw new Error('Invalid EBML header');
  let value = id ? first : first & ((1 << (8 - length)) - 1);
  let unknown = !id && value === ((1 << (8 - length)) - 1);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[start + i];
    unknown = unknown && bytes[start + i] === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error('EBML size out of range');
  return { value, length, unknown };
}

function elements(bytes, start, end, allowUnknown = false) {
  const result = [];
  for (let p = start; p < end;) {
    const id = vint(bytes, p, true);
    const size = vint(bytes, p + id.length);
    const body = p + id.length + size.length;
    const stop = size.unknown && allowUnknown ? end : body + size.value;
    if ((size.unknown && !allowUnknown) || stop > end || stop < body) throw new Error('Incomplete EBML element');
    result.push({ id: id.value, start: p, body, end: stop, unknown: size.unknown });
    p = stop;
  }
  return result;
}

function sizeBytes(value) {
  let length = 1;
  while (value >= 2 ** (7 * length) - 1) length++;
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256); }
  out[0] |= 1 << (8 - length);
  return out;
}

function join(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function layout(bytes) {
  const top = elements(bytes, 0, bytes.length, true);
  const segment = top.find(e => e.id === 0x18538067);
  if (top[0]?.id !== 0x1a45dfa3 || !segment) return null;
  const children = elements(bytes, segment.body, segment.end, true);
  if (children.some(e => e.unknown && e.id !== 0x1f43b675)) return null;
  // Inserting metadata shifts byte offsets. Never touch an indexed container.
  if (children.some(e => e.id === 0x114d9b74 || e.id === 0x1c53bb6b)) return null;
  const infos = children.filter(e => e.id === 0x1549a966);
  if (infos.length !== 1) return null;
  const info = infos[0];
  const fields = elements(bytes, info.body, info.end);
  if (fields.some(e => e.id === 0x4489)) return null;
  const scale = fields.find(e => e.id === 0x2ad7b1);
  let nanoseconds = 1_000_000;
  if (scale) {
    nanoseconds = 0;
    for (const byte of bytes.subarray(scale.body, scale.end)) nanoseconds = nanoseconds * 256 + byte;
  }
  if (!Number.isSafeInteger(nanoseconds) || nanoseconds <= 0) return null;
  return { segment, info, nanoseconds };
}

/** Add a decoded Duration only to unindexed WebM files missing it. */
export function withWebmDuration(bytes, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return bytes;
  try {
    const found = layout(bytes);
    if (!found) return bytes;
    const { segment, info, nanoseconds } = found;
    const duration = new Uint8Array(11);
    duration.set([0x44, 0x89, 0x88]);
    new DataView(duration.buffer).setFloat64(3, seconds * 1e9 / nanoseconds);
    const body = join(bytes.subarray(info.body, info.end), duration);
    const replacement = join(new Uint8Array([0x15, 0x49, 0xa9, 0x66]), sizeBytes(body.length), body);
    const segmentBody = join(bytes.subarray(segment.body, info.start), replacement, bytes.subarray(info.end, segment.end));
    const segmentHeader = segment.unknown ? bytes.subarray(segment.start, segment.body)
      : join(new Uint8Array([0x18, 0x53, 0x80, 0x67]), sizeBytes(segmentBody.length));
    return join(bytes.subarray(0, segment.start), segmentHeader, segmentBody, bytes.subarray(segment.end));
  } catch { return bytes; }
}

/** Decode only missing-duration WebM; native playback remains the fallback. */
export async function recordingPlaybackSource(recording, win = window, timeoutMs = 5000) {
  const mime = recording.audio_mime || 'audio/webm';
  const original = `data:${mime};base64,${recording.audio_b64}`;
  if (!/^audio\/webm(?:;|$)/i.test(mime) || recording.audio_b64.length > MAX_AUDIO_B64) return original;
  let timer;
  try {
    const bytes = Uint8Array.from(win.atob(recording.audio_b64), c => c.charCodeAt(0));
    if (!layout(bytes)) return original;
    const Ctor = win.OfflineAudioContext || win.webkitOfflineAudioContext;
    if (!Ctor) return original;
    const context = new Ctor(1, 1, 48000);
    const decoded = await Promise.race([
      context.decodeAudioData(bytes.buffer.slice(0)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Duration decode timed out')), timeoutMs); }),
    ]);
    const repaired = withWebmDuration(bytes, decoded.duration);
    if (repaired === bytes) return original;
    return await blobToDataUrl(new Blob([repaired], { type: mime }));
  } catch { return original; }
  finally { clearTimeout(timer); }
}
