import test from 'node:test';
import assert from 'node:assert/strict';
import { withWebmDuration, recordingPlaybackSource } from '../public/js/recording-playback.js';

const join = (...parts) => new Uint8Array(parts.flatMap(p => [...p]));
const element = (id, body) => join(id, [0x80 | body.length], body);
const header = element([0x1a, 0x45, 0xdf, 0xa3], []);
const scale = element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]);
const info = element([0x15, 0x49, 0xa9, 0x66], scale);
const block = element([0xa3], [0x81, 0, 0, 0x80, 0xf8, 1, 2, 3]);
const cluster = join([0x1f, 0x43, 0xb6, 0x75, 0xff], block);
const file = join(header, [0x18, 0x53, 0x80, 0x67, 0xff], info, cluster);

test('missing WebKit duration is added without modifying the compressed audio', () => {
  const original = file.slice();
  const repaired = withWebmDuration(file, 28.1475);
  assert.equal(repaired.length, file.length + 11);
  assert.deepEqual(file, original, 'the stored source is not mutated');
  assert.deepEqual(repaired.slice(-cluster.length), cluster, 'all cluster bytes remain identical');
  const offset = repaired.findIndex((v, i) => v === 0x44 && repaired[i + 1] === 0x89);
  assert.equal(new DataView(repaired.buffer).getFloat64(offset + 3), 28147.5);
  assert.strictEqual(withWebmDuration(repaired, 30), repaired, 'existing duration is left alone');
});

test('finite segment sizes are rebuilt and invalid/indexed containers are untouched', () => {
  const finite = join(header, element([0x18, 0x53, 0x80, 0x67], join(info, element([0x1f, 0x43, 0xb6, 0x75], block))));
  assert.equal(withWebmDuration(finite, 5).length, finite.length + 11);
  const indexed = join(header, [0x18, 0x53, 0x80, 0x67, 0xff], element([0x11, 0x4d, 0x9b, 0x74], []), info, cluster);
  for (const bytes of [indexed, file.slice(0, 10), new Uint8Array([0]), new Uint8Array([255])]) {
    assert.strictEqual(withWebmDuration(bytes, 5), bytes);
  }
  assert.strictEqual(withWebmDuration(file, Infinity), file);
});

test('unavailable or failed duration decoder falls back to the original playable recording', async () => {
  const rec = { audio_mime: 'audio/webm', audio_b64: Buffer.from(file).toString('base64') };
  const original = `data:audio/webm;base64,${rec.audio_b64}`;
  assert.equal(await recordingPlaybackSource(rec, { atob }), original);
  const failed = { atob, OfflineAudioContext: class { decodeAudioData() { return Promise.reject(new Error('unsupported')); } } };
  assert.equal(await recordingPlaybackSource(rec, failed), original);
  const stalled = { atob, OfflineAudioContext: class { decodeAudioData() { return new Promise(() => {}); } } };
  assert.equal(await recordingPlaybackSource(rec, stalled, 10), original);
});
