// Runs the on-device speech model (Whisper) in a background thread so the page stays responsive.
// The model files download once from huggingface.co and are cached by the browser.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

env.allowLocalModels = false;
try { env.backends.onnx.wasm.numThreads = 1; } catch (e) { /* GitHub Pages cannot enable multi-threading */ }

let asr = null;

self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const attempts = [];
      if (self.navigator && self.navigator.gpu) attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
      attempts.push({ device: 'wasm', dtype: 'q8' });
      let lastErr = null;
      for (const a of attempts) {
        try {
          asr = await pipeline('automatic-speech-recognition', m.model, { ...a, progress_callback: p => self.postMessage({ type: 'progress', p }) });
          self.postMessage({ type: 'ready', device: a.device });
          return;
        } catch (err) { lastErr = err; }
      }
      throw lastErr || new Error('The speech model did not load');
    }
    if (m.type === 'run') {
      if (!asr) throw new Error('Speech model is not loaded');
      const out = await asr(m.audio, { chunk_length_s: 30 });
      self.postMessage({ type: 'result', id: m.id, text: (out && out.text) || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
