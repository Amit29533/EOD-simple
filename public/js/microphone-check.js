import { micCapability, startAudioRecorder } from './exam-audio.js';

// The practice clip stays on this device and never starts or updates an exam.
export function wireMicrophoneCheck(root, { win = window, onUnmount } = {}) {
  const start = root.querySelector('[data-mic-start]');
  const stop = root.querySelector('[data-mic-stop]');
  const status = root.querySelector('[data-mic-status]');
  const player = root.querySelector('[data-mic-player]');
  const result = root.ownerDocument.createElement('p');
  result.className = 'mic-result';
  result.setAttribute('role', 'status');
  status.before(result);
  const setResult = (state, text) => {
    result.dataset.state = state;
    result.textContent = `${state === 'success' ? '✓' : state === 'failure' ? '✕' : '○'} ${text}`;
  };
  setResult('idle', 'Microphone not tested yet');
  let stream, recorder, timer, url;
  let disposed = false;
  const release = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  const finish = () => {
    clearTimeout(timer);
    if (recorder?.state === 'recording') recorder.stop();
    release();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    finish();
    player.pause();
    player.removeAttribute('src');
    if (url) win.URL.revokeObjectURL(url);
  };
  onUnmount?.(dispose);
  if (!micCapability(win).canRecord) {
    start.disabled = true;
    setResult('failure', 'Microphone test unavailable');
    status.textContent = 'Audio recording is unavailable. Use a supported browser over HTTPS, or contact your administrator.';
    return dispose;
  }
  stop.onclick = finish;
  start.onclick = async () => {
    start.disabled = true;
    player.pause();
    setResult('pending', 'Waiting for microphone permission');
    status.textContent = 'Allow microphone access in your browser…';
    try {
      const acquired = await win.navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed) { acquired.getTracks().forEach((t) => t.stop()); return; }
      stream = acquired;
      setResult('success', 'Microphone permission allowed');
      const recording = startAudioRecorder(win, stream);
      recorder = recording.recorder;
      const chunks = [];
      let recordingFailed = false;
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onstop = () => {
        release();
        if (disposed) return;
        start.disabled = false;
        stop.disabled = true;
        if (recordingFailed) return;
        const blob = new win.Blob(chunks, { type: recording.mime });
        if (!blob.size) { setResult('failure', 'No recording captured'); status.textContent = 'No audio captured. Check your microphone and try again.'; return; }
        if (url) win.URL.revokeObjectURL(url);
        url = win.URL.createObjectURL(blob);
        player.src = url;
        player.hidden = false;
        setResult('success', 'Microphone access and recording successful');
        status.textContent = 'Recording complete. Play it back and check that your voice is clear. If silent, check your input device and test again.';
        start.textContent = 'Test again';
      };
      recorder.onerror = () => { recordingFailed = true; finish(); setResult('failure', 'Microphone recording failed'); status.textContent = 'Recording failed. Check your input device and try again.'; start.disabled = false; stop.disabled = true; };
      recorder.start();
      stop.disabled = false;
      status.textContent = 'Recording — speak a short sentence. Stops automatically after 10 seconds.';
      timer = setTimeout(finish, 10_000);
    } catch (err) {
      release();
      if (disposed) return;
      start.disabled = false;
      setResult('failure', err.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Microphone access failed');
      status.textContent = err.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow microphone access in your browser’s site settings, then try again.'
        : 'Could not access your microphone. Check that it is connected and available, then try again.';
    }
  };
  return dispose;
}
