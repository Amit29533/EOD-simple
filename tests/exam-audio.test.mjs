import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUDIO_B64, speechRecognitionCtor, buildTextAnswer, dataUrlToB64, transcriptFromSpeechEvent,
  micCapability, pickRecorderMime, startAudioRecorder, blobToStoredAudio, RECORDER_AUDIO_BPS,
} from '../public/js/exam-audio.js';

test('buildTextAnswer prefers spoken source when the candidate only recorded', () => {
  const a = buildTextAnswer({ transcript: 'Lakehouse with Unity Catalog' });
  assert.equal(a.source, 'audio');
  assert.equal(a.text, 'Lakehouse with Unity Catalog');
  assert.equal(a.transcript, 'Lakehouse with Unity Catalog');
});

test('buildTextAnswer keeps typed source when the candidate edited the transcript', () => {
  const a = buildTextAnswer({ text: 'Typed lakehouse design', transcript: 'spoken bit' });
  assert.equal(a.source, 'typed');
  assert.equal(a.text, 'Typed lakehouse design');
});

test('buildTextAnswer stores compact audio payloads and drops oversized clips', () => {
  const ok = buildTextAnswer({ transcript: 'hi', audioB64: 'YWJj', audioMime: 'audio/webm' });
  assert.equal(ok.audio_b64, 'YWJj');
  assert.equal(ok.audio_mime, 'audio/webm');
  const huge = buildTextAnswer({ transcript: 'hi', audioB64: 'A'.repeat(MAX_AUDIO_B64 + 1) });
  assert.equal(huge.audio_b64, undefined);
});

test('transcriptFromSpeechEvent concatenates SpeechRecognition results', () => {
  const ev = { results: [[{ transcript: 'medallion ' }], [{ transcript: 'architecture' }]] };
  assert.equal(transcriptFromSpeechEvent(ev), 'medallion architecture');
});

test('speechRecognitionCtor reads webkit aliases', () => {
  assert.equal(speechRecognitionCtor({}), null);
  function Fake() {}
  assert.equal(speechRecognitionCtor({ webkitSpeechRecognition: Fake }), Fake);
});

test('dataUrlToB64 strips the data: prefix', () => {
  assert.equal(dataUrlToB64('data:audio/webm;base64,QQ=='), 'QQ==');
});

test('micCapability reports what the browser can actually capture', () => {
  assert.deepEqual(micCapability({}), { hasStream: false, hasRecorder: false, canRecord: false });
  assert.equal(micCapability({ navigator: { mediaDevices: { getUserMedia() {} } } }).canRecord, false, 'no MediaRecorder');
  assert.equal(micCapability({ MediaRecorder: function MR() {} }).canRecord, false, 'no getUserMedia (insecure context)');
  const full = { navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: function MR() {} };
  assert.equal(micCapability(full).canRecord, true);
});

test('pickRecorderMime / startAudioRecorder prefer a codec the browser supports', () => {
  const win = { MediaRecorder: class { static isTypeSupported(t) { return t === 'audio/ogg;codecs=opus'; } } };
  assert.equal(pickRecorderMime(win), 'audio/ogg;codecs=opus');
  assert.equal(pickRecorderMime({}), '', 'no isTypeSupported is not an error');

  const seen = [];
  class Recorder {
    constructor(stream, opts) { seen.push({ stream, opts }); this.mimeType = 'audio/webm;codecs=opus'; }
    static isTypeSupported() { return true; }
  }
  const { recorder, mime } = startAudioRecorder({ MediaRecorder: Recorder }, 'STREAM');
  assert.ok(recorder instanceof Recorder);
  assert.equal(mime, 'audio/webm;codecs=opus');
  assert.equal(seen[0].opts.mimeType, 'audio/webm;codecs=opus');
  assert.equal(seen[0].opts.audioBitsPerSecond, RECORDER_AUDIO_BPS);
});

test('startAudioRecorder degrades instead of breaking the exam', () => {
  assert.throws(() => startAudioRecorder({}, 'STREAM'), /MediaRecorder is not available/);
  // A browser that rejects the requested profile still gets a plain recorder.
  class Picky {
    constructor(stream, opts) {
      if (opts) throw new Error('NotSupportedError');
      this.mimeType = 'audio/mp4';
    }
    static isTypeSupported() { return false; }
  }
  const { recorder, mime } = startAudioRecorder({ MediaRecorder: Picky }, 'STREAM');
  assert.ok(recorder instanceof Picky);
  assert.equal(mime, 'audio/mp4', 'the recorder reports its own type');
});

test('blobToStoredAudio flags a clip it had to drop for size', async () => {
  // The exam must be able to tell the candidate their recording was thrown
  // away, instead of letting them believe a mandatory answer was submitted.
  const realFileReader = globalThis.FileReader;
  let payload = 'YWJjZA=='; // "ABCD"
  globalThis.FileReader = class {
    readAsDataURL() { this.result = `data:audio/webm;base64,${payload}`; setTimeout(() => this.onload(), 0); }
  };
  try {
    assert.deepEqual(
      await blobToStoredAudio({ size: 4, type: 'audio/webm' }),
      { audioB64: 'YWJjZA==', audioMime: 'audio/webm', dropped: false },
    );
    payload = 'A'.repeat(MAX_AUDIO_B64 + 1);
    const huge = await blobToStoredAudio({ size: 10, type: 'audio/webm' }, 'audio/mp4');
    assert.deepEqual(huge, { audioB64: '', audioMime: '', dropped: true }, 'oversized clip is reported as dropped');
    assert.deepEqual(await blobToStoredAudio(null), { audioB64: '', audioMime: '', dropped: false });
    assert.deepEqual(await blobToStoredAudio({ size: 0 }), { audioB64: '', audioMime: '', dropped: false });
  } finally {
    globalThis.FileReader = realFileReader;
  }
});
