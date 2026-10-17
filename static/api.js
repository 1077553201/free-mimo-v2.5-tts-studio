/* =========================================================================
   api.js — 浏览器直连 MiMo 接口

   静态版没有后端了，原来 mimo_client.py 干的活搬到这里：
   - build_payload：把界面字段翻译成 messages + audio
   - synthesize：非流式，拿整段 wav
   - streamSynthesize：流式，逐块吐 PCM（顺带在本地拼一份 wav，供下载）
   - 音频工具：PCM→WAV、录音 webm→WAV、时长探测

   上游允许跨域（Access-Control-Allow-Origin: *，
   Allow-Headers 只放行 authorization 和 content-type），
   所以只能用标准 Authorization 头，不能加自定义头。
   ========================================================================= */
(function () {
  'use strict';

  const CFG = window.MIMO_CONFIG;
  const SR = CFG.SAMPLE_RATE;

  /* ---------------------------------------------------------------- 工具 */

  function normalizeBase(base) {
    let url = String(base || CFG.DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    if (!url) url = CFG.DEFAULT_BASE_URL;
    if (url.endsWith('/chat/completions')) url = url.slice(0, -'/chat/completions'.length);
    return url;
  }

  function endpoint(base) {
    return normalizeBase(base) + CFG.CHAT_PATH;
  }

  function headers(key) {
    return {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    };
  }

  /** 把上游/网络错误翻译成一句人话 */
  function friendlyError(status, message) {
    const msg = String(message || '').trim();
    if (status === 0) {
      if (/failed to fetch|load failed|networkerror/i.test(msg)) {
        return '连不上接口：可能是地址写错、网络不通，或该地址不允许浏览器直连（CORS）';
      }
      return msg || '网络请求失败，请检查地址与网络';
    }
    if (status === 401) return 'API Key 无效或已过期';
    if (status === 403) return '没有该模型的访问权限，请确认账号已开通';
    if (status === 404) return '接口地址不对（404），检查 Base URL 是否到 /v1';
    if (status === 429) return '触发限流或配额不足，请稍后重试';
    if (status === 413) return '请求体太大，样本可能超过了 10MB';
    if (400 <= status && status < 500) return '请求被拒绝（' + status + '）：' + (msg || '参数有误');
    if (500 <= status && status < 600) return '上游服务异常（' + status + '）：' + (msg || '');
    return msg || '请求失败';
  }

  function extractError(status, bodyText) {
    let text = String(bodyText || '').trim();
    try {
      const data = JSON.parse(text);
      const err = data && data.error;
      if (typeof err === 'string') text = err;
      else if (err && typeof err.message === 'string') text = err.message;
      else if (data && typeof data.message === 'string') text = data.message;
      else if (data && typeof data.detail === 'string') text = data.detail;
    } catch (e) { /* 非 JSON，原样用 */ }
    return { message: friendlyError(status, text), raw: text.slice(0, 600) };
  }

  async function readError(res) {
    let text = '';
    try {
      text = await res.text();
    } catch (e) { /* 忽略 */ }
    return extractError(res.status, text);
  }

  /* ---------------------------------------------------------------- payload */

  /**
   * 规则（与官方文档一致）：
   * - 待合成文本放 role=assistant
   * - role=user 放风格指令；voicedesign 时它就是音色描述且必填
   * - voicedesign + optimize_text_preview 时可以完全不发 assistant
   */
  function buildPayload(opts) {
    const model = opts.model;
    const text = String(opts.text || '').trim();
    const instruction = String(opts.instruction || '').trim();
    const stream = !!opts.stream;
    const messages = [];

    if (model === 'mimo-v2.5-tts-voicedesign') {
      if (!instruction) throw new Error('音色设计需要在 user 消息里提供音色描述');
      messages.push({ role: 'user', content: instruction });
      if (text) messages.push({ role: 'assistant', content: text });
      else if (!opts.optimize) throw new Error('请填写要合成的文本，或开启「智能润色」让模型自动生成');
    } else {
      if (instruction) messages.push({ role: 'user', content: instruction });
      if (!text) throw new Error('要合成的文本不能为空');
      messages.push({ role: 'assistant', content: text });
    }

    const audio = { format: stream ? 'pcm16' : 'wav' };
    if (model === 'mimo-v2.5-tts-voicedesign') {
      if (typeof opts.optimize === 'boolean') audio.optimize_text_preview = opts.optimize;
    } else if (model === 'mimo-v2.5-tts-voiceclone') {
      if (!opts.sampleDataUrl) throw new Error('音色复刻需要先选择或上传一段音频样本');
      audio.voice = opts.sampleDataUrl;
    } else if (opts.voice) {
      audio.voice = opts.voice;
    }

    const payload = { model, messages, audio };
    if (stream) payload.stream = true;
    return payload;
  }

  /** 给「查看请求」面板用的脱敏副本 */
  function redactPayload(payload) {
    const clone = JSON.parse(JSON.stringify(payload));
    const audio = clone.audio || {};
    const voice = audio.voice;
    if (typeof voice === 'string' && voice.startsWith('data:')) {
      const idx = voice.indexOf('base64,');
      const head = idx >= 0 ? voice.slice(0, idx + 7) : 'data:…base64,';
      const b64 = idx >= 0 ? voice.slice(idx + 7) : '';
      audio.voice = head + '…(' + Math.round((b64.length * 3) / 4 / 1024) + 'KB)';
    }
    return clone;
  }

  /* ---------------------------------------------------------------- 请求 */

  async function post(payload, key, base, signal) {
    const res = await fetch(endpoint(base), {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(payload),
      signal,
    }).catch((e) => {
      if (e && e.name === 'AbortError') throw e;
      const err = new Error(friendlyError(0, e && e.message));
      err.name = 'NetworkError';
      throw err;
    });
    if (!res.ok) {
      const info = await readError(res);
      const err = new Error(info.message);
      err.raw = info.raw;
      err.status = res.status;
      throw err;
    }
    return res;
  }

  function pickMessageAudio(data) {
    try {
      const a = data.choices[0].message.audio;
      return a && a.data ? a.data : null;
    } catch (e) {
      return null;
    }
  }

  function pickDeltaAudio(evt) {
    try {
      const d = evt.choices[0].delta;
      const a = d && d.audio;
      if (a && typeof a === 'object' && a.data) return a.data;
      if (typeof a === 'string' && a) return a;
      return null;
    } catch (e) {
      return null;
    }
  }

  function pickDeltaText(evt) {
    try {
      const d = evt.choices[0].delta;
      return typeof d.content === 'string' && d.content ? d.content : null;
    } catch (e) {
      return null;
    }
  }

  /** 非流式：整段 wav */
  async function synthesize(opts) {
    const payload = buildPayload({ ...opts, stream: false });
    const started = performance.now();
    const res = await post(payload, opts.key, opts.baseUrl, opts.signal);
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('上游返回了无法解析的内容');
    if (data.error) throw new Error(extractError(502, JSON.stringify(data)).message);
    const b64 = pickMessageAudio(data);
    if (!b64) throw new Error('上游没有返回音频数据（文本可能为空，或该模型不支持当前参数）');
    const blob = base64ToBlob(b64, 'audio/wav');
    return {
      blob,
      base64: b64,
      bytes: blob.size,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  /**
   * 流式：逐块回调 PCM。
   * onEvent({type:'audio', data}) / {type:'text', text} / {type:'error'}
   * 返回 { pcm: Uint8Array[], firstAudioMs, totalMs, text }
   */
  async function streamSynthesize(opts) {
    const payload = buildPayload({ ...opts, stream: true });
    const started = performance.now();
    const res = await post(payload, opts.key, opts.baseUrl, opts.signal);
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const pcm = [];
    let firstAudioMs = null;
    let buf = '';
    let text = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const body = line.slice(5).trim();
          if (!body || body === '[DONE]') continue;
          let evt;
          try {
            evt = JSON.parse(body);
          } catch (e) {
            continue;
          }
          if (evt && evt.error) {
            throw new Error(extractError(502, JSON.stringify(evt)).message);
          }
          const audio = pickDeltaAudio(evt);
          if (audio) {
            if (firstAudioMs == null) firstAudioMs = Math.round(performance.now() - started);
            const bytes = base64ToBytes(audio);
            if (bytes) {
              pcm.push(bytes);
              if (opts.onAudio) opts.onAudio(audio, bytes);
            }
          }
          const t = pickDeltaText(evt);
          if (t) {
            text += t;
            if (opts.onText) opts.onText(t);
          }
        }
      }
    }
    return {
      pcm,
      firstAudioMs,
      totalMs: Math.round(performance.now() - started),
      text,
    };
  }

  /* ---------------------------------------------------------------- 音频 */

  const B64_CHUNK = 0x8000;

  function base64ToBytes(b64) {
    try {
      const clean = String(b64).replace(/\s+/g, '');
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  function base64ToBlob(b64, mime) {
    const bytes = base64ToBytes(b64);
    return bytes ? new Blob([bytes], { type: mime || 'application/octet-stream' }) : new Blob([]);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
      fr.readAsDataURL(blob);
    });
  }

  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
    }
    return btoa(out);
  }

  /** 把若干段 PCM16LE 单声道字节拼成标准 WAV */
  function pcmToWavBlob(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const rate = sampleRate || SR;
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) v.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + total, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeStr(36, 'data');
    v.setUint32(40, total, true);
    return new Blob([header, ...chunks], { type: 'audio/wav' });
  }

  /** 由 Float32 PCM 编成 WAV（录音转码用） */
  function floatToWavBlob(samples, sampleRate) {
    const len = samples.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) v.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + len * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeStr(36, 'data');
    v.setUint32(40, len * 2, true);
    let offset = 44;
    for (let i = 0; i < len; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /** 任意浏览器能解码的音频 → 单声道 WAV（替代后端 ffmpeg） */
  async function toWavBlob(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持音频解码');
    const ctx = new AC();
    try {
      const ab = await blob.arrayBuffer();
      const audio = await ctx.decodeAudioData(ab);
      let mono;
      if (audio.numberOfChannels === 1) {
        mono = audio.getChannelData(0);
      } else {
        const a = audio.getChannelData(0);
        const b = audio.getChannelData(1);
        mono = new Float32Array(a.length);
        for (let i = 0; i < a.length; i += 1) mono[i] = (a[i] + b[i]) / 2;
      }
      return floatToWavBlob(mono, audio.sampleRate);
    } finally {
      try { ctx.close(); } catch (e) { /* 忽略 */ }
    }
  }

  /** WAV 文件直接从头部算时长，其它格式用 <audio> 探测 */
  function wavDuration(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const v = new DataView(fr.result);
          if (v.byteLength < 44) return resolve(0);
          const rate = v.getUint32(24, true);
          const channels = v.getUint16(22, true);
          const bits = v.getUint16(34, true);
          const dataLen = v.getUint32(40, true) || v.byteLength - 44;
          const bytesPerSec = rate * channels * (bits / 8);
          resolve(bytesPerSec ? dataLen / bytesPerSec : 0);
        } catch (e) {
          resolve(0);
        }
      };
      fr.onerror = () => resolve(0);
      fr.readAsArrayBuffer(blob);
    });
  }

  function probeDuration(blob) {
    if (blob.type === 'audio/wav') return wavDuration(blob);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      const done = (val) => {
        URL.revokeObjectURL(url);
        resolve(val || 0);
      };
      audio.onloadedmetadata = () => done(isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => done(0);
      audio.src = url;
      setTimeout(() => done(isFinite(audio.duration) ? audio.duration : 0), 2500);
    });
  }

  window.MimoApi = {
    DEFAULT_BASE_URL: CFG.DEFAULT_BASE_URL,
    normalizeBase,
    endpoint,
    buildPayload,
    redactPayload,
    synthesize,
    streamSynthesize,
    friendlyError,
    readError,
    base64ToBytes,
    base64ToBlob,
    blobToDataUrl,
    bytesToBase64,
    pcmToWavBlob,
    floatToWavBlob,
    toWavBlob,
    wavDuration,
    probeDuration,
  };
})();
