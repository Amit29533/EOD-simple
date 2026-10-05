/** Isolated Chromium media test; synthetic microphone, no production data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const durationMs = Number(process.env.RECORDING_TEST_MS || 2000);
assert.ok(Number.isFinite(durationMs) && durationMs >= 1000 && durationMs <= 120000);
const candidates = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  if (await fs.access(candidate).then(() => true, () => false)) { executable = candidate; break; }
}
if (!executable) throw new Error('Set CHROME_PATH to an installed Chromium browser.');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ecod-media-test-'));
const helper = await fs.readFile(fileURLToPath(new URL('../public/js/exam-audio.js', import.meta.url)));
const playbackHelper = await fs.readFile(fileURLToPath(new URL('../public/js/recording-playback.js', import.meta.url)));
// Optional private local fixtures: never checked into the repository.
const fixtures = process.env.RECORDING_PLAYBACK_DIR ? await Promise.all(
  ['sama-0.webm', 'sama-1.webm', 'rsa-0.webm'].map(async name => ({
    name, audio_mime: 'audio/webm;codecs=opus',
    audio_b64: (await fs.readFile(path.join(process.env.RECORDING_PLAYBACK_DIR, name))).toString('base64'),
  }))) : [];
const server = http.createServer((req, res) => {
  res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : req.url === '/fixtures' ? 'application/json' : 'text/html');
  res.end(req.url === '/exam-audio.js' ? helper : req.url === '/recording-playback.js' ? playbackHelper
    : req.url === '/fixtures' ? JSON.stringify(fixtures) : '<!doctype html><title>ECOD isolated media test</title>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let socket;
try {
  browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', origin],
  { windowsHide: true, stdio: 'ignore' });
  browser.on('error', (error) => { console.error(error.message); });
  let debugPort;
  for (let i = 0; i < 150; i++) {
    const active = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    if (active) { debugPort = active.split(/\r?\n/)[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(debugPort, 'isolated browser started');
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const tab = tabs.find((t) => t.type === 'page' && t.url.startsWith(origin));
  assert.ok(tab, 'local test page exists');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  };
  const command = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, durationMs + 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  for (let i = 0; ; i++) {
    const page = await command('Runtime.evaluate', { expression: 'location.origin + ":" + document.readyState', returnByValue: true });
    if (page.result?.value === `${origin}:complete`) break;
    assert.ok(i < 50, 'local page loaded before evaluating media code');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(fixtures.length ? 'Checking private local playback fixtures in isolated Chromium…'
    : `Recording ${durationMs / 1000}s in isolated Chromium using a synthetic microphone…`);
  const evaluated = await command('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => {
      ${fixtures.length ? `
      const { recordingPlaybackSource } = await import('${origin}/recording-playback.js');
      const fixtures = await (await fetch('${origin}/fixtures')).json();
      const results = [];
      for (const recording of fixtures) {
        const original = 'data:' + recording.audio_mime + ';base64,' + recording.audio_b64;
        const fixed = await recordingPlaybackSource(recording);
        const durationOf = async src => {
          const audio = document.createElement('audio');
          const ready = new Promise((resolve, reject) => {
            audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 'unknown');
            audio.onerror = () => reject(new Error('Playback metadata failed'));
          });
          audio.src = src;
          document.body.append(audio);
          try { return await ready; } finally { audio.removeAttribute('src'); audio.remove(); }
        };
        const context = new OfflineAudioContext(1, 1, 48000);
        const before = await context.decodeAudioData(await (await fetch(original)).arrayBuffer());
        const after = await context.decodeAudioData(await (await fetch(fixed)).arrayBuffer());
        let identical = before.length === after.length && before.numberOfChannels === after.numberOfChannels;
        for (let channel = 0; identical && channel < before.numberOfChannels; channel++) {
          const a = before.getChannelData(channel), b = after.getChannelData(channel);
          for (let i=0;i<a.length;i++) if (a[i] !== b[i]) { identical=false; break; }
        }
        results.push({ name: recording.name, originalDuration: await durationOf(original),
          repairedDuration: await durationOf(fixed), decodedSeconds: after.duration, pcmIdentical: identical,
          sourceChanged: original !== fixed });
      }
      return { playback: results };
      ` : ''}
      const { startAudioRecorder, finishAudioRecorder, blobToStoredAudio, MAX_AUDIO_B64 } = await import('${origin}/exam-audio.js');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The fake device's timer-driven samples can lag the WebM timestamp
      // timeline. Mix in a continuous, sample-clock calibration tone so this
      // test can detect end truncation without relying on that fake clock.
      const captureContext = new AudioContext();
      await captureContext.resume();
      const destination = captureContext.createMediaStreamDestination();
      captureContext.createMediaStreamSource(stream).connect(destination);
      const tone = captureContext.createOscillator();
      tone.frequency.value = 440;
      tone.connect(destination);
      tone.start();
      const chunks = [];
      try {
        const { recorder, mime } = startAudioRecorder(window, destination.stream);
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.start();
        await new Promise(resolve => setTimeout(resolve, ${durationMs}));
        await finishAudioRecorder(recorder);
        const blob = new Blob(chunks, { type: mime });
        const stored = await blobToStoredAudio(blob, mime);
        const context = new OfflineAudioContext(1, 1, 48000);
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        const player = document.createElement('audio');
        player.src = URL.createObjectURL(blob);
        document.body.append(player);
        await new Promise((resolve, reject) => {
          player.onloadedmetadata = resolve;
          player.onerror = () => reject(new Error('Player cannot load captured audio'));
          setTimeout(() => reject(new Error('Audio metadata timeout')), 5000);
        });
        const nativeDuration = Number.isFinite(player.duration) ? player.duration : 'unknown';
        URL.revokeObjectURL(player.src);
        return { mime, bytes: blob.size, base64Length: stored.audioB64.length,
          storageLimit: MAX_AUDIO_B64, dropped: stored.dropped, decodedSeconds: decoded.duration, nativeDuration };
      } finally {
        tone.stop();
        destination.stream.getTracks().forEach(track => track.stop());
        stream.getTracks().forEach(track => track.stop());
        await captureContext.close();
      }
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const result = evaluated.result.value;
  console.log(JSON.stringify(result, null, 2));
  if (result.playback) {
    for (const clip of result.playback) {
      assert.ok(Number.isFinite(clip.repairedDuration));
      assert.ok(Math.abs(clip.repairedDuration - clip.decodedSeconds) < 0.1);
      assert.equal(clip.pcmIdentical, true, 'metadata repair preserves every decoded audio sample');
      assert.equal(clip.sourceChanged, clip.name.startsWith('sama'), 'existing RSA metadata is unchanged');
    }
    console.log('PASS native duration display and sample-identical playback for historical WebKit and Chrome files.');
  } else {
  assert.ok(result.bytes > 0, 'recorded nonempty audio');
  assert.equal(result.dropped, false, 'full answer fits the portal storage cap');
  assert.ok(result.base64Length <= result.storageLimit);
  assert.ok(result.decodedSeconds >= durationMs / 1000 - 0.5, 'captured audio decodes for the complete recording interval');
  console.log('PASS real MediaRecorder capture, final chunk, storage encoding and audio decoding.');
  }
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    const exited = once(browser, 'exit');
    browser.kill();
    await exited;
  }
  await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(profile);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ecod-media-test-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
