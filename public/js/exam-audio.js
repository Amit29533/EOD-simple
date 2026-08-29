/** Client helpers for exam-hall audio answers (mic + speech-to-text). */

export const MAX_AUDIO_B64 = 400_000;

export function speechRecognitionCtor(win = typeof window !== 'undefined' ? window : globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
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

export async function blobToStoredAudio(blob, mimeFallback = 'audio/webm') {
  if (!blob || !blob.size) return { audioB64: '', audioMime: '' };
  const url = await blobToDataUrl(blob);
  const audioB64 = dataUrlToB64(url);
  if (!audioB64 || audioB64.length > MAX_AUDIO_B64) return { audioB64: '', audioMime: '' };
  return { audioB64, audioMime: blob.type || mimeFallback };
}

export function transcriptFromSpeechEvent(ev) {
  if (!ev?.results) return '';
  let bits = '';
  for (let i = 0; i < ev.results.length; i += 1) {
    bits += (ev.results[i][0]?.transcript || '') + ' ';
  }
  return bits.replace(/\s+/g, ' ').trim();
}
