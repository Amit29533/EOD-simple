/**
 * Client helpers for exam-hall audio answers (mic + speech-to-text).
 *
 * Every open question is answered out loud: the recording is the answer and the
 * text box holds optional notes (the contract itself lives in
 * src/core/spoken-answer.mjs and is projected onto each question as
 * `audio_required`). These helpers keep that path workable inside a two-minute
 * window in whatever browser the candidate happens to use.
 */

export const MAX_AUDIO_B64 = 400_000;

/**
 * Speech-only encoder profile. The store keeps at most MAX_AUDIO_B64 base64
 * characters (~300 KB of audio), so a full 2-minute answer must encode at
 * ~16 kbps mono; a default-rate opus clip of the same length is twice that and
 * would be dropped as "too large", silently destroying a mandatory answer.
 */
export const RECORDER_AUDIO_BPS = 16_000;
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2',
];

export function speechRecognitionCtor(win = typeof window !== 'undefined' ? window : globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

/**
 * Can this browser capture a microphone at all? `canRecord` is false where
 * `getUserMedia` (needs a secure context) or `MediaRecorder` is missing; the
 * exam then falls back to a typed answer that is flagged for the assessor
 * instead of stranding the candidate on a question they cannot answer.
 */
export function micCapability(win = typeof window !== 'undefined' ? window : globalThis) {
  const hasStream = Boolean(win?.navigator?.mediaDevices?.getUserMedia);
  const hasRecorder = typeof win?.MediaRecorder === 'function';
  return { hasStream, hasRecorder, canRecord: hasStream && hasRecorder };
}

/** The first recorder mime type this browser actually supports ('' if none). */
export function pickRecorderMime(win = typeof window !== 'undefined' ? window : globalThis) {
  const isSupported = win?.MediaRecorder?.isTypeSupported;
  if (typeof isSupported !== 'function') return '';
  return RECORDER_MIME_CANDIDATES.find((t) => {
    try { return isSupported(t); } catch { return false; }
  }) || '';
}

/**
 * Build a MediaRecorder for the exam, low-bitrate/mono so a two-minute answer
 * survives the storage cap. Throws when the browser cannot record; falls back to
 * a plain `new MediaRecorder(stream)` when it rejects the requested profile.
 */
export function startAudioRecorder(win, stream) {
  const Ctor = win?.MediaRecorder;
  if (typeof Ctor !== 'function') throw new Error('MediaRecorder is not available in this browser');
  const mime = pickRecorderMime(win);
  const opts = { audioBitsPerSecond: RECORDER_AUDIO_BPS, audioChannels: 1 };
  if (mime) opts.mimeType = mime;
  let recorder;
  try {
    recorder = new Ctor(stream, opts);
  } catch {
    recorder = new Ctor(stream);
  }
  return { recorder, mime: recorder.mimeType || mime || 'audio/webm' };
}

/** Merge typed text, live transcript, and optional recorded audio into a persistable answer. */
export function buildTextAnswer({ text = '', transcript = '', audioB64 = '', audioMime = '' } = {}) {
  const typed = String(text || '').trim();
  const spoken = String(transcript || '').trim();
  const merged = typed || spoken;
  const usedAudio = Boolean(spoken || audioB64) && (!typed || typed === spoken);
  const out = {
    text: merged,
    transcript: spoken,
    source: usedAudio ? 'audio' : 'typed',
  };
  const b64 = String(audioB64 || '').replace(/\s/g, '');
  if (b64 && b64.length <= MAX_AUDIO_B64) {
    out.audio_b64 = b64;
    out.audio_mime = String(audioMime || 'audio/webm').slice(0, 80);
  }
  return out;
}

export function dataUrlToB64(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  return i >= 0 ? s.slice(i + 1) : s;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

/**
 * Encode a recorded blob for storage. `dropped` reports a clip that had to be
 * discarded for being too large, so the exam UI can tell the candidate their
 * recording did not survive instead of letting them believe it was submitted.
 */
export async function blobToStoredAudio(blob, mimeFallback = 'audio/webm') {
  if (!blob || !blob.size) return { audioB64: '', audioMime: '', dropped: false };
  const url = await blobToDataUrl(blob);
  const audioB64 = dataUrlToB64(url);
  if (!audioB64) return { audioB64: '', audioMime: '', dropped: false };
  if (audioB64.length > MAX_AUDIO_B64) {
    return { audioB64: '', audioMime: '', dropped: true };
  }
  return { audioB64, audioMime: blob.type || mimeFallback, dropped: false };
}

export function transcriptFromSpeechEvent(ev) {
  if (!ev?.results) return '';
  let bits = '';
  for (let i = 0; i < ev.results.length; i += 1) {
    bits += (ev.results[i][0]?.transcript || '') + ' ';
  }
  return bits.replace(/\s+/g, ' ').trim();
}
