/* demos/show/render/shim.js — makes demos.html?show=1 renderable off the clock
   ============================================================================
   Injected by render.mjs BEFORE any page script runs. The gallery, the show
   client, the analysis engine and every scene run unmodified; this file
   replaces only the things that tie them to real time and real hardware:

     * the clock      performance.now / Date.now / rAF / setTimeout / setInterval
                      all read one virtual clock that only __R.step(k) advances,
                      by exactly one video frame.
     * the deck       #localAudio never loads or plays anything. Its currentTime
                      is the virtual transport, so the show client's drift logic
                      sees a deck that is perfectly in sync.
     * the analyser   AudioContext is a stand-in whose AnalyserNode computes what
                      the real one would have (Web Audio spec: Blackman window,
                      FFT, magnitude/N, smoothing over time, dB) from the wav's
                      own samples at the virtual playhead. The engine downstream
                      of getFloatFrequencyData() is the real one.
     * the follower   fetch('/show/...') is answered here from the timeline that
                      make_timeline.py resolved with the real cue engine, through
                      the same long-poll contract show-client.js already speaks.
     * randomness     Math.random is seeded, so a re-render is the same picture.

   Nothing here draws. render.mjs screenshots the page after each step().
   ========================================================================== */
(() => {
  'use strict';
  const CFG = window.__RCFG;
  if (!CFG) return;                      // not a render session: stay inert
  const R = (window.__R = {});

  const real = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    fetch: window.fetch.bind(window),
  };
  const realSleep = (ms) => new Promise((r) => real.setTimeout(r, ms));
  async function until(test, what, timeoutMs) {
    // the clock is virtual, so a timeout is counted in polls, not read off it
    const tries = Math.ceil((timeoutMs || 60000) / 4);
    for (let i = 0; i < tries; i++) {
      const v = test();
      if (v) return v;
      await realSleep(4);
    }
    throw new Error('render shim: timed out waiting for ' + what);
  }

  /* ------------------------------------------------------------------ clock
     Starts well away from zero: the engine and the gallery both use "last
     timestamp is falsy" to mean "first frame". */
  const FRAME_MS = 1000 / CFG.fps;
  const T0 = 600000;                     // virtual ms at output frame 0
  let vms = T0 + CFG.first_frame * FRAME_MS - 1;
  const EPOCH = Date.UTC(2026, 7, 23, 4, 0, 0);
  function vDateNow() { return EPOCH + Math.floor(vms); }
  performance.now = () => vms;
  Date.now = vDateNow;

  let timerId = 1;
  const timers = new Map();
  window.setTimeout = (fn, ms, ...args) => {
    const id = timerId++;
    timers.set(id, { id, fn, args, at: vms + Math.max(0, +ms || 0), every: 0 });
    return id;
  };
  window.setInterval = (fn, ms, ...args) => {
    const id = timerId++;
    const every = Math.max(1, +ms || 0);
    timers.set(id, { id, fn, args, at: vms + every, every });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };

  function runTimers() {
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const t of timers.values()) {
        if (t.at <= vms && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) return;
      if (next.every) next.at += next.every; else timers.delete(next.id);
      try { if (typeof next.fn === 'function') next.fn(...next.args); }
      catch (err) { console.error('[render] timer', err); }
    }
    throw new Error('render shim: timer storm');
  }
  // every interval callback once, now — used to land the deck start on the
  // exact frame the transport starts instead of up to 250 ms later
  function kickIntervals() {
    for (const t of Array.from(timers.values())) {
      if (!t.every) continue;
      try { t.fn(...t.args); } catch (err) { console.error('[render] interval', err); }
    }
  }

  let rafQ = [], rafId = 1;
  window.requestAnimationFrame = (cb) => { const id = rafId++; rafQ.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { rafQ = rafQ.filter((r) => r.id !== id); };
  function runRaf() {
    const q = rafQ; rafQ = [];
    for (const r of q) r.cb(vms);
  }

  /* ------------------------------------------------------------- randomness */
  let seed = (CFG.seed >>> 0) || 0x9e3779b9;
  Math.random = () => {                  // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* ------------------------------------------------------------------- deck
     Accessors on HTMLAudioElement.prototype shadow HTMLMediaElement's for
     <audio> only, so the insert <video> keeps its real ones. */
  const A = { src: '', playing: false, base: 0, startV: 0, from: 0 };
  const audioNow = () => (A.playing
    ? Math.min(CFG.duration, A.base + (vms - A.startV) / 1000) : A.base);
  const def = (proto, props) => {
    for (const [k, d] of Object.entries(props)) {
      Object.defineProperty(proto, k, Object.assign({ configurable: true }, d));
    }
  };
  def(HTMLAudioElement.prototype, {
    src: { get() { return A.src; },
           set(v) { A.src = String(v); A.base = 0; A.playing = false; } },
    currentTime: { get: audioNow,
                   set(v) { A.base = Math.max(0, +v || 0); A.startV = vms; A.from = A.base; } },
    duration: { get() { return A.src ? CFG.duration : NaN; } },
    paused: { get() { return !A.playing; } },
    ended: { get() { return false; } },
    readyState: { get() { return A.src ? 4 : 0; } },
    playbackRate: { get() { return 1; }, set() {} },
    load: { value() {} },
    play: { value() {
      if (!A.playing) {
        A.base = audioNow(); A.startV = vms; A.from = A.base; A.playing = true;
        this.dispatchEvent(new Event('play'));
      }
      return Promise.resolve();
    } },
    pause: { value() {
      if (A.playing) {
        A.base = audioNow(); A.playing = false;
        this.dispatchEvent(new Event('pause'));
      }
    } },
  });

  /* The insert clip must not free-run: it stays really-paused and step() seeks
     it to the transport, frame by frame. The page still sees play()/paused. */
  const vPlaying = new WeakMap();
  def(HTMLVideoElement.prototype, {
    play: { value() { vPlaying.set(this, true); return Promise.resolve(); } },
    pause: { value() { vPlaying.set(this, false); } },
    paused: { get() { return !vPlaying.get(this); } },
  });

  /* -------------------------------------------------------------------- pcm
     Mono float32 (0.5*(L+R), which is the analyser's own down-mix) served by
     render.mjs with Range support; held as a small sliding set of chunks. */
  const SR = CFG.sample_rate;
  const CHUNK = SR * 20;
  const chunks = new Map();              // index -> Float32Array
  async function loadChunk(i) {
    if (chunks.has(i) || i < 0 || i * CHUNK >= CFG.samples) return;
    const a = i * CHUNK, b = Math.min(CFG.samples, a + CHUNK);
    const r = await real.fetch(CFG.pcm_url, {
      headers: { Range: 'bytes=' + (a * 4) + '-' + (b * 4 - 1) } });
    if (r.status !== 206) throw new Error('render shim: pcm range fetch HTTP ' + r.status);
    chunks.set(i, new Float32Array(await r.arrayBuffer()));
    for (const k of chunks.keys()) if (k < i - 2) chunks.delete(k);
  }
  async function ensurePcm(sec) {
    const s = Math.floor(sec * SR);
    const lo = Math.floor((s - 32768) / CHUNK), hi = Math.floor((s + SR) / CHUNK);
    for (let i = Math.max(0, lo); i <= hi; i++) if (!chunks.has(i)) await loadChunk(i);
  }
  function sampleAt(i) {
    if (i < 0 || i >= CFG.samples) return 0;
    const c = chunks.get((i / CHUNK) | 0);
    return c ? c[i % CHUNK] : 0;
  }

  /* --------------------------------------------------------------- analyser */
  const fftPlans = new Map();
  function plan(n) {
    let p = fftPlans.get(n);
    if (p) return p;
    const bits = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = -Math.sin(2 * Math.PI * i / n);
    }
    // Blackman, alpha = 0.16, exactly as the Web Audio spec states it
    const win = new Float64Array(n);
    const a0 = 0.42, a1 = 0.5, a2 = 0.08;
    for (let i = 0; i < n; i++) {
      win[i] = a0 - a1 * Math.cos(2 * Math.PI * i / n) + a2 * Math.cos(4 * Math.PI * i / n);
    }
    p = { rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) };
    fftPlans.set(n, p);
    return p;
  }
  function fft(p, n) {
    const { re, im, cos, sin } = p;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  class FakeParam { constructor(v) { this.value = v; } }
  class FakeNode { connect(n) { return n; } disconnect() {} }
  class FakeAnalyser extends FakeNode {
    constructor() {
      super();
      this._n = 2048; this.smoothingTimeConstant = 0.8;
      this.minDecibels = -100; this.maxDecibels = -30;
      this._sm = null; this._db = null; this._at = -1;
    }
    get fftSize() { return this._n; }
    set fftSize(v) { this._n = v | 0; this._sm = null; }
    get frequencyBinCount() { return this._n >> 1; }
    getFloatFrequencyData(out) {
      const n = this._n, half = n >> 1;
      if (!this._sm) { this._sm = new Float64Array(half); this._db = new Float32Array(half); }
      if (vms !== this._at) {            // one analysis per frame, like one per render quantum
        this._at = vms;
        const p = plan(n);
        // the most recent n samples the element put out; a deck that is not
        // playing (or had not started yet) put out silence
        const end = A.playing ? Math.round(audioNow() * SR) : -1;
        const first = Math.round(A.from * SR);
        for (let i = 0; i < n; i++) {
          const s = end - n + i;
          const x = (A.playing && s >= first) ? sampleAt(s) : 0;
          p.re[p.rev[i]] = x * p.win[i];
          p.im[p.rev[i]] = 0;
        }
        fft(p, n);
        const tau = Math.min(1, Math.max(0, +this.smoothingTimeConstant || 0));
        const sm = this._sm, db = this._db;
        for (let k = 0; k < half; k++) {
          const mag = Math.hypot(p.re[k], p.im[k]) / n;
          sm[k] = tau * sm[k] + (1 - tau) * mag;
          db[k] = sm[k] > 0 ? 20 * Math.log10(sm[k]) : this.minDecibels;
        }
      }
      out.set(this._db.subarray(0, Math.min(out.length, half)));
    }
  }
  class FakeAudioContext {
    constructor() { this.sampleRate = SR; this.state = 'running'; this.destination = new FakeNode(); }
    get currentTime() { return vms / 1000; }
    createAnalyser() { return new FakeAnalyser(); }
    createMediaElementSource() { return new FakeNode(); }
    createMediaStreamSource() { return new FakeNode(); }
    createDelay() { const n = new FakeNode(); n.delayTime = new FakeParam(0); return n; }
    createGain() { const n = new FakeNode(); n.gain = new FakeParam(1); return n; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  window.AudioContext = window.webkitAudioContext = FakeAudioContext;

  /* --------------------------------------------------------------- follower
     The state box, as show-client.js sees it over /show/status and the
     /show/events long poll. `cur` is one timeline event. */
  const EV = CFG.events;
  let cur = CFG.initial;                 // {scene, logo, video, palette}
  let evNext = CFG.initial_next;         // index of the next event to deliver
  let seq = 1;
  const transport = { track: CFG.audio, position: CFG.initial_pos, playing: false,
                      duration: CFG.duration };
  let pendingPoll = null;                // resolver of the parked long poll
  let polledSeq = 0;                     // highest `since` the page has asked with

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200, headers: { 'Content-Type': 'application/json' } });
  const snapshot = () => ({
    seq, scene: cur.scene, logo: !!cur.logo, stage: CFG.stage, source: 'cue',
    override: null, video: cur.video || null, palette: cur.palette || null,
    presets_rev: 1, live: { rev: 0 }, transport: Object.assign({}, transport),
    audible: false, drift_seconds: CFG.drift_seconds, logo_style: CFG.logo_style,
  });
  function push() {
    seq += 1;
    if (pendingPoll) { const r = pendingPoll; pendingPoll = null; r(json(snapshot())); }
  }
  // resolved once the page has applied the current seq and come back for more
  const applied = () => until(() => polledSeq >= seq, 'the show client to apply state', 20000);

  window.fetch = (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); }
    catch (e) { return real.fetch(input, init); }
    const p = url.pathname;
    if (url.origin !== location.origin || !p.startsWith('/show/')) return real.fetch(input, init);
    if (p === '/show/status') return Promise.resolve(json(snapshot()));
    if (p === '/show/events') {
      const since = parseInt(url.searchParams.get('since'), 10) || 0;
      polledSeq = Math.max(polledSeq, since);
      if (since < seq) return Promise.resolve(json(snapshot()));
      return new Promise((res) => { pendingPoll = res; });
    }
    if (p === '/show/presets') return Promise.resolve(json({ presets: CFG.presets || {}, rev: 1 }));
    if (p === '/show/page') return Promise.resolve(json({ ok: true }));
    if (p.startsWith('/show/audio/')) return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.resolve(json({ error: 'not in a render' }, 404));
  };

  /* ---------------------------------------------------------- css animations
     The logo's opacity transition and its 9 s breathe run on the compositor's
     clock, which is real. Each one is paused the moment it exists and walked
     along the virtual clock instead. */
  function syncAnims() {
    for (const a of document.getAnimations()) {
      if (a.__v0 === undefined) { a.__v0 = vms; try { a.pause(); } catch (e) { /* gone */ } }
      const t = vms - a.__v0;
      let end = Infinity;
      try { end = a.effect.getComputedTiming().endTime; } catch (e) { /* no effect */ }
      try {
        if (Number.isFinite(end) && t >= end) a.finish();
        else a.currentTime = t;
      } catch (e) { /* removed underneath us */ }
    }
  }

  /* ------------------------------------------------------------ settle/video */
  function sceneReady() {
    const v = window.__viz;
    if (!v) return false;
    const s = v.slots[v.active];
    if (!s || v.DEMOS[v.active].name !== cur.scene) return false;
    if (s.status === 'error') throw new Error('scene ' + cur.scene + ' failed to load: ' + s.err);
    if (s.status !== 'ok' || !s.inst) return false;
    if (s.inst.failed) throw new Error('scene ' + cur.scene + ' failed to compile');
    return !('ready' in s.inst) || !!s.inst.ready;
  }
  function backdropOwed() {
    const v = window.__viz;
    const s = v.slots[v.active];
    return !!(v.DEMOS[v.active].backdrop && s && s.inst
      && typeof s.inst.backdropWanted === 'function' && s.inst.backdropWanted()
      && !v.backdropInst);
  }

  async function syncVideo(pos) {
    const el = document.getElementById('showvideo');
    if (!cur.video || !el || !el.classList.contains('on')) return null;
    await until(() => el.readyState >= 1 || el.error, 'insert metadata ' + cur.video.video, 20000);
    if (el.error) throw new Error('insert ' + cur.video.video + ' failed: code ' + el.error.code);
    const want = Math.min(Math.max(0, pos - (cur.video.at || 0)),
                          Math.max(0, (el.duration || 0) - 0.02));
    if (Math.abs(el.currentTime - want) > 1e-4 || el.readyState < 2) {
      const seeked = new Promise((res) => el.addEventListener('seeked', res, { once: true }));
      el.currentTime = want;
      await Promise.race([seeked, realSleep(4000)]);
    }
    await until(() => el.readyState >= 2, 'insert frame ' + cur.video.video, 20000);
    // the decoded frame still has to reach the compositor before a screenshot
    await new Promise((res) => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      if (el.requestVideoFrameCallback) el.requestVideoFrameCallback(fin);
      real.setTimeout(fin, 120);
    });
    await new Promise((res) => real.raf(() => real.raf(res)));
    return want;
  }

  /* ------------------------------------------------------------------- step
     Advance to output frame k and draw it. Frames below CFG.start are warm-up
     and are stepped but never captured by the driver. */
  let booted = false;
  R.boot = async () => {
    await until(() => window.__viz && polledSeq >= 1, 'the gallery and show client to boot', 60000);
    await until(sceneReady, 'the first scene (' + cur.scene + ')', 120000);
    booted = true;
    return true;
  };

  R.step = async (k) => {
    if (!booted) throw new Error('render shim: step before boot');
    vms = T0 + k * FRAME_MS;
    const pos = k / CFG.fps;

    let moved = false;
    while (evNext < EV.length && EV[evNext].frame <= k) { cur = EV[evNext++]; moved = true; }
    const starting = !transport.playing && k >= CFG.play_frame;
    if (moved || starting) {
      if (starting) transport.playing = true;
      transport.position = Math.max(0, pos);
      push();
      await applied();
      syncAnims();                       // catch a transition before any real wait
      if (starting) kickIntervals();     // the deck starts on THIS frame
    }

    runTimers();
    await realSleep(0);                  // let fetch/import continuations land
    if (!sceneReady()) await until(sceneReady, 'scene ' + cur.scene, 120000);
    const vt = await syncVideo(pos);
    if (A.playing) await ensurePcm(audioNow());

    runRaf();
    if (CFG.debug) R.debug.canvas = window.__viz.slots[window.__viz.active].canvas.toDataURL('image/png');
    if (backdropOwed()) {
      // first frame of a backdrop scene kicks off the nebula's import; hold the
      // clock until it exists and draw the frame again with it in place
      await until(() => !backdropOwed(), 'the nebula backdrop', 30000);
      vms += 1e-6;                       // a distinct instant, so the engine re-analyses
      runRaf();
    }
    syncAnims();
    for (let i = 0; i < (CFG.settle_raf || 0); i++) await new Promise((res) => real.raf(res));

    const v = window.__viz;
    return {
      k, scene: v.DEMOS[v.active].name, mode: v.engine.mode,
      audio: A.playing ? audioNow() : null, video: vt, logo: !!cur.logo,
    };
  };

  /* Verification hooks (render/verify-*.mjs): drive the clock and the pcm
     cache by hand, without a gallery page. Unused by a render. */
  R.debug = { setClock(ms) { vms = ms; }, clock: () => vms, ensurePcm, audioNow, canvas: null };

  R.info = () => {
    const out = { ua: navigator.userAgent, dpr: devicePixelRatio,
                  view: [innerWidth, innerHeight], immersive: document.body.className };
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) { out.gpu = 'unknown: ' + e; }
    return out;
  };
})();
