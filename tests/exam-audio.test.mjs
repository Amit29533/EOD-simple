import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUDIO_B64, speechRecognitionCtor, buildTextAnswer, dataUrlToB64, transcriptFromSpeechEvent,
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
