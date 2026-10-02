#!/usr/bin/env node
/* Does shim.js's stand-in AnalyserNode compute what Chrome's real one does?

   Runs the same stretch of the stage's audio through (a) a real AnalyserNode
   inside an OfflineAudioContext, read at 60 Hz suspend points, and (b) the
   shim's analyser on the virtual clock at the same sample positions, for both
   of the engine's analyser configurations, and reports the worst dB gap over
   every bin the engine can see (above its -85 dB floor).

       node verify-analyser.mjs <work/stage dir> [startSeconds] [seconds]     */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(process.argv[2] || path.join(HERE, 'work', 'main'));
const START = Number(process.argv[3] || 300), SECS = Number(process.argv[4] || 8);
const pcm = path.join(work, 'audio-mono.f32');
const SR = 44100, size = fs.statSync(pcm).size;

const srv = http.createServer((req, res) => {
  if (!req.url.startsWith('/__pcm')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><audio id="a"></audio>'); return; }
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { 'Content-Length': size }); fs.createReadStream(pcm).pipe(res); return; }
  const a = Number(m[1]), b = Math.min(Number(m[2]), size - 1);
  res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
  fs.createReadStream(pcm, { start: a, end: b }).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
const cfg = { fps: 60, first_frame: 0, duration: size / 4 / SR, sample_rate: SR, samples: size / 4,
  pcm_url: '/__pcm', events: [], initial: {}, initial_next: 0, initial_pos: 0, seed: 1 };
await page.addInitScript('window.__RCFG = ' + JSON.stringify(cfg) + ';');
await page.addInitScript({ path: path.join(HERE, 'shim.js') });
await page.goto(`http://127.0.0.1:${srv.address().port}/`);

const out = await page.evaluate(async ({ START, SECS, SR }) => {
  const D = window.__R.debug;
  const n0 = Math.round(START * SR), len = Math.round(SECS * SR);
  const r = await fetch('/__pcm', { headers: { Range: `bytes=${n0 * 4}-${(n0 + len) * 4 - 1}` } });
  const pcm = new Float32Array(await r.arrayBuffer());
  const CONFIGS = [[16384, 0.35], [4096, 0.4]];

  // (a) the real thing, offline
  const off = new OfflineAudioContext(1, len, SR);
  const buf = off.createBuffer(1, len, SR); buf.copyToChannel(pcm, 0);
  const src = off.createBufferSource(); src.buffer = buf;
  const reals = CONFIGS.map(([n, tau]) => { const a = off.createAnalyser(); a.fftSize = n; a.smoothingTimeConstant = tau; src.connect(a); a.connect(off.destination); return a; });
  src.start(0);
  const points = [], realData = [];
  for (let k = 30; ; k++) {
    const q = Math.ceil(k * SR / 60 / 128) * 128;      // suspends land on render quanta
    if (q >= len - 128) break;
    points.push(q);
    off.suspend(q / SR).then(() => {
      realData.push(reals.map((a) => { const d = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(d); return d; }));
      off.resume();
    });
  }
  await off.startRendering();

  // (b) the shim, same sample positions. The real analysers have been smoothing
  // since t=0, so the shim is walked through every one of the same instants.
  const ctx = new AudioContext();
  const fakes = CONFIGS.map(([n, tau]) => { const a = ctx.createAnalyser(); a.fftSize = n; a.smoothingTimeConstant = tau; return a; });
  const el = document.getElementById('a');
  el.src = 'x';
  const v0 = 1e6;
  D.setClock(v0); el.play(); el.currentTime = START;
  const res = CONFIGS.map(() => ({ worst: 0, sum: 0, n: 0, worstAt: null }));
  for (let i = 0; i < points.length; i++) {
    D.setClock(v0 + points[i] / SR * 1000);
    await D.ensurePcm(D.audioNow());
    fakes.forEach((a, c) => {
      const d = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(d);
      if (i < 20) return;                      // both have forgotten their zero start by now
      const rd = realData[i][c];
      for (let b = 1; b < d.length; b++) {
        if (rd[b] < -85 && d[b] < -85) continue;      // below the engine's floor: invisible
        const e = Math.abs(rd[b] - d[b]);
        res[c].sum += e; res[c].n++;
        if (e > res[c].worst) { res[c].worst = e; res[c].worstAt = [i, b, rd[b], d[b]]; }
      }
    });
  }
  return { points: points.length, res: res.map((r, c) => ({ fft: CONFIGS[c][0], tau: CONFIGS[c][1], bins: r.n, mean_dB: r.sum / r.n, worst_dB: r.worst, worstAt: r.worstAt })) };
}, { START, SECS, SR });
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close();
