import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, SKIP } from './helpers/jsdom.mjs';
import { wireMicrophoneCheck } from '../public/js/microphone-check.js';
import { uniqueUsername, generatePassword } from '../public/js/account-form.js';

function fixture(getUserMedia) {
  const dom = new JSDOM('<button data-mic-start></button><button data-mic-stop disabled></button><p data-mic-status></p><audio data-mic-player hidden></audio>');
  const root = dom.window.document.body;
  const player = root.querySelector('audio');
  player.pause = () => {};
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
  class Recorder {
    state = 'inactive';
    mimeType = 'audio/webm';
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['practice']) });
      this.onstop?.();
    }
  }
  let revoked = 0;
  const win = { navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } }, MediaRecorder: Recorder, Blob, URL: { createObjectURL: () => 'blob:practice', revokeObjectURL: () => { revoked++; } } };
  let dispose;
  wireMicrophoneCheck(root, { win, onUnmount: (fn) => { dispose = fn; } });
  return { dom, root, stream, player, dispose, stopped: () => stopped, revoked: () => revoked };
}

test('mic practice requests access only on click, offers playback, releases tracks and clip on unmount', { skip: SKIP }, async () => {
  const f = fixture();
  try {
    assert.equal(f.stopped(), 0);
    await f.root.querySelector('[data-mic-start]').onclick();
    assert.equal(f.root.querySelector('[data-mic-stop]').disabled, false);
    f.root.querySelector('[data-mic-stop]').click();
    assert.equal(f.player.hidden, false);
    assert.equal(f.player.getAttribute('src'), 'blob:practice');
    assert.ok(f.stopped() > 0);
    f.dispose();
    assert.equal(f.player.getAttribute('src'), null);
    assert.equal(f.revoked(), 1);
  } finally { f.dispose(); f.dom.window.close(); }
});

test('leaving during permission request stops the stream when it arrives', { skip: SKIP }, async () => {
  let resolve;
  const f = fixture(() => new Promise((r) => { resolve = r; }));
  try {
    const pending = f.root.querySelector('[data-mic-start]').onclick();
    f.dispose();
    resolve(f.stream);
    await pending;
    assert.equal(f.stopped(), 1);
    assert.equal(f.player.hidden, true);
  } finally { f.dom.window.close(); }
});

test('denied microphone permission gives an actionable retry', { skip: SKIP }, async () => {
  const f = fixture(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  try {
    await f.root.querySelector('[data-mic-start]').onclick();
    assert.match(f.root.querySelector('[data-mic-status]').textContent, /site settings/);
    assert.equal(f.root.querySelector('[data-mic-start]').disabled, false);
  } finally { f.dispose(); f.dom.window.close(); }
});

test('generated usernames normalize names and resolve collisions; passwords use crypto', () => {
  const time = new Date('2026-10-01T10:11:12Z');
  const first = uniqueUsername('Amít Singh', [], time);
  assert.equal(first, 'amit.singh.20261001101112');
  assert.equal(uniqueUsername('Amít Singh', [{ username: first.toUpperCase() }], time), `${first}.2`);
  assert.match(uniqueUsername('李', [], time), /^[a-z0-9._-]{3,}$/);
  assert.equal(generatePassword().length, 20);
});
