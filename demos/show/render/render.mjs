#!/usr/bin/env node
/* demos/show/render/render.mjs — frame-exact offline render of a show stage
   ============================================================================
   Renders what the TV showed for one stage (visuals + cues) against that
   stage's audio, one video frame at a time, with no real-time anything:

     make_timeline.py   the real cue engine, resolved per frame
     shim.js            virtual clock + offline analyser, injected into the page
     this file          serves the repo, steps the page, screenshots each frame
                        into ffmpeg, then muxes the original audio back on

       node render.mjs --stage main                 # the whole stage
       node render.mjs --stage main --from 1650 --to 1685 --out /tmp/clip.mp4
       node render.mjs --stage main --workers 4     # split at scene cuts

   The page is the show's own demos.html?show=1 — same gallery, same show
   client, same engine, same scenes. Only its clock and its audio source are
   replaced (see shim.js for exactly what, and why).

   A stage is rendered as CHUNKS that begin at scene cues, each its own .mp4
   under work/<stage>/, concatenated losslessly at the end. That is what makes a
   multi-hour render resumable (--resume skips finished chunks) and splittable
   across workers. A chunk that does not start the stage warms the analysis
   engine up on the preceding audio with the screen BLACK, then lands the scene
   on the cue frame — a scene's first appearance is a fresh instance on the
   night too, so the cut is where the seam belongs.
   ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* ------------------------------------------------------------------- args */
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes('--' + name);

const STAGE = opt('stage');
if (!STAGE) { console.error('usage: render.mjs --stage <main|opener> [--from s] [--to s] [--out file] [--workers n] [--resume]'); process.exit(2); }
const FPS = Number(opt('fps', 60));
const W = Number(opt('width', 1920)), H = Number(opt('height', 1080));
const CRF = String(opt('crf', 17));
const PRESET = opt('preset', 'medium');
const WORKERS = Math.max(1, Number(opt('workers', 1)));
// frame capture format: 'jpeg:Q' or 'png'. PNG is lossless but its encode is
// ~100 ms on a busy 1080p picture, 4x the JPEG path; measured through the final
// x264 encode the two are indistinguishable (see README), so JPEG is the default.
const [SHOT_FMT, SHOT_Q] = String(opt('shot', 'jpeg:95')).split(':');
const SEED = Number(opt('seed', 20260822));
const WARM_SECS = Number(opt('warm', 45));     // engine warm-up before a mid-stage chunk
const IDLE_SECS = 2;                           // cued-and-paused hold before frame 0
const WORK = path.resolve(opt('work', path.join(HERE, 'work', STAGE)));
const IS_WORKER = flag('worker');
// --debug-frames DIR: also save every frame's screenshot AND the scene canvas as
// read back inside the same step, for verify-capture.py (is frame k really k?)
const DEBUG_DIR = opt('debug-frames') ? path.resolve(opt('debug-frames')) : null;
if (DEBUG_DIR) fs.mkdirSync(DEBUG_DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), IS_WORKER ? '[w' + opt('worker-id', '?') + ']' : '[render]', ...a);

fs.mkdirSync(WORK, { recursive: true });

/* ---------------------------------------------------------------- timeline */
const tlPath = path.join(WORK, 'timeline.json');
if (!IS_WORKER) {
  const out = execFileSync('python3', [path.join(HERE, 'make_timeline.py'), '--stage', STAGE, '--fps', String(FPS)],
    { maxBuffer: 64 << 20 });
  fs.writeFileSync(tlPath, out);
}
const TL = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
const EV = TL.events;

const FROM = Math.max(0, Math.round(Number(opt('from', 0)) * FPS));
const TO = Math.min(TL.frames, opt('to') === undefined ? TL.frames : Math.round(Number(opt('to')) * FPS));
if (!(TO > FROM)) { console.error('nothing to render: --from/--to select no frames'); process.exit(2); }

/* Chunk boundaries: every frame the SCENE changes, inside [FROM, TO). */
function chunkList() {
  const cuts = [FROM];
  for (let i = 1; i < EV.length; i++) {
    const f = EV[i].frame;
    if (f > FROM && f < TO && EV[i].scene !== EV[i - 1].scene) cuts.push(f);
  }
  return cuts.map((a, i) => ({ a, b: i + 1 < cuts.length ? cuts[i + 1] : TO }));
}
const chunkFile = (c) => path.join(WORK, 'chunk-' + String(c.a).padStart(7, '0') + '-' + String(c.b).padStart(7, '0') + '.mp4');

/* --------------------------------------------------------------------- pcm */
const pcmPath = path.join(WORK, 'audio-mono.f32');
function ensurePcm() {
  const src = fs.statSync(TL.audio_path);
  if (fs.existsSync(pcmPath) && fs.statSync(pcmPath).mtimeMs > src.mtimeMs) return;
  log('decoding', path.basename(TL.audio_path), '-> mono float32 for the analyser');
  // 0.5*(L+R) is the AnalyserNode's own stereo down-mix; no resample, no dither
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', TL.audio_path,
    '-af', 'pan=mono|c0=0.5*c0+0.5*c1', '-f', 'f32le', '-c:a', 'pcm_f32le', pcmPath + '.part']);
  fs.renameSync(pcmPath + '.part', pcmPath);
}
const sampleRate = () => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
  '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', TL.audio_path]).toString().trim());

/* ------------------------------------------------------------------ server
   The repo, statically, with Range (the insert clips seek) — plus the two
   things that are not files: the pcm, and demos.html with one line added so
   the driver can see scene readiness. The file on disk is never touched. */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.glsl': 'text/plain', '.txt': 'text/plain', '.wav': 'audio/wav' };
const HOOK_ANCHOR = 'select(initialIndex());';
const HOOK = 'window.__viz = { slots, DEMOS, engine, get active() { return active; }, '
  + 'get backdropInst() { return backdropInst; } };\n';

function startServer() {
  const srv = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400).end(); return; }
    const send = (status, headers, body) => { res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : body); };
    if (p === '/demos.html') {
      let html = fs.readFileSync(path.join(REPO, 'demos.html'), 'utf8');
      if (!html.includes(HOOK_ANCHOR)) { send(500, {}, 'render hook anchor missing from demos.html'); return; }
      // no webfont fetches: show mode draws no text, and a render must not wait on the network
      html = html.replace(/<link[^>]+fonts\.g[^>]+>\n?/g, '').replace(HOOK_ANCHOR, HOOK + HOOK_ANCHOR);
      send(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }, html);
      return;
    }
    const file = p === '/__pcm' ? pcmPath : path.join(REPO, path.normalize(p));
    if (p !== '/__pcm' && !file.startsWith(REPO + path.sep)) { send(403, {}, ''); return; }
    let st;
    try { st = fs.statSync(file); } catch (e) { send(404, {}, 'not found'); return; }
    if (!st.isFile()) { send(404, {}, 'not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let a = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let b = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (a > b || a >= st.size) { send(416, { 'Content-Range': 'bytes */' + st.size }, ''); return; }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start: a, end: b }).pipe(res);
      return;
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

/* ------------------------------------------------------------------ encode */
function startEncoder(outFile) {
  // RGB screenshots -> BT.709 limited-range 4:2:0, tagged, so every player
  // shows the colours the TV did
  const ff = spawn('ffmpeg', ['-v', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', SHOT_FMT === 'jpeg' ? 'mjpeg' : 'png', '-i', '-',
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p',
    '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-g', String(FPS * 2),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', outFile], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code + ' for ' + outFile))));
  });
  ff.stdin.on('error', () => {});      // surfaced through `done`
  return {
    async write(buf) { if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain'); },
    async close() { ff.stdin.end(); await done; },
  };
}

/* ---------------------------------------------------------------- one run
   Render chunks[i..] in order in ONE page, so consecutive chunks share a
   continuous page state exactly like the night did. */
async function renderRun(chunks, srv) {
  const first = chunks[0].a;
  const fromStart = first === 0;
  const warm = fromStart ? Math.round(IDLE_SECS * FPS) : Math.min(first, Math.round(WARM_SECS * FPS));
  const firstFrame = first - warm;

  // the state the stage is in on arriving at `first`
  let idx = 0;
  while (idx + 1 < EV.length && EV[idx + 1].frame <= first) idx++;
  const landing = { ...EV[idx], frame: first };
  if (landing.palette) landing.palette = { ...landing.palette, live: false };   // a late join snaps
  if (landing.video && landing.video.at < first / FPS) landing.video = null;     // no half clips
  const events = fromStart ? EV : [landing, ...EV.slice(idx + 1)];
  const cfg = {
    fps: FPS, stage: STAGE, seed: SEED + first, audio: TL.audio, duration: TL.duration,
    sample_rate: sampleRate(), samples: Math.floor(fs.statSync(pcmPath).size / 4),
    pcm_url: '/__pcm', logo_style: TL.logo_style, drift_seconds: TL.drift_seconds,
    presets: loadPresets(),
    events,
    // from the top: the stage's own first state, cued and paused. mid-stage:
    // BLACK with the deck already running, so only the engine warms up.
    initial: fromStart ? EV[0] : { scene: 'BLACK', logo: false, video: null, palette: landing.palette },
    initial_next: fromStart ? 1 : 0,
    initial_pos: Math.max(0, firstFrame / FPS),
    first_frame: firstFrame,
    play_frame: fromStart ? 0 : firstFrame,
    debug: !!DEBUG_DIR,
    settle_raf: Number(process.env.RENDER_SETTLE_RAF || 2),
  };

  const browser = await chromium.launch({
    executablePath: CHROME, headless: !flag('headed'),
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion', '--hide-scrollbars',
      '--force-color-profile=srgb', '--force-device-scale-factor=1',
      // screenshots wait on a compositor frame; unthrottled, that wait is ~1/3 shorter
      ...(process.env.RENDER_VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']),
      // a whole stage is 30+ scenes in one page, each its own GL context, and
      // Chrome drops the oldest past 16 — which would black out a scene's return
      '--max-active-webgl-contexts=64',
      ...(process.env.RENDER_EXTRA_FLAGS || '').split(' ').filter(Boolean)],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, screen: { width: W, height: H },
      deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('PAGE ERROR', e.message));
    page.on('console', (m) => { if (m.type() === 'error') log('page:', m.text().slice(0, 300)); });
    await page.addInitScript('window.__RCFG = ' + JSON.stringify(cfg) + ';');
    await page.addInitScript({ path: path.join(HERE, 'shim.js') });
    await page.goto(`http://127.0.0.1:${srv.address().port}/demos.html?show=1#BLACK`);
    await page.evaluate(() => window.__R.boot());
    const info = await page.evaluate(() => window.__R.info());
    log('page up:', info.gpu, '·', info.view.join('x'), '@' + info.dpr, '·', info.immersive);
    if (/swiftshader|llvmpipe/i.test(info.gpu)) throw new Error('software GL — refusing to render: ' + info.gpu);
    if (info.view[0] !== W || info.view[1] !== H) throw new Error('viewport is ' + info.view + ', wanted ' + W + 'x' + H);

    const cdp = await ctx.newCDPSession(page);
    const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot',
      SHOT_FMT === 'jpeg' ? { format: 'jpeg', quality: Number(SHOT_Q || 95) }
        : { format: 'png', optimizeForSpeed: true })).data, 'base64');

    for (let k = firstFrame; k < first; k++) await page.evaluate((n) => window.__R.step(n), k);

    for (const c of chunks) {
      const out = chunkFile(c);
      const enc = startEncoder(out + '.part.mp4');
      const t0 = Date.now();
      let st = null, tStep = 0, tShot = 0, tEnc = 0;
      // one hash per captured frame, beside the chunk: two renders of the same
      // frames can be compared without decoding anything
      const hashes = [];
      for (let k = c.a; k < c.b; k++) {
        const a = performance.now();
        st = await page.evaluate((n) => window.__R.step(n), k);
        const b = performance.now();
        const png = await shot();
        const d = performance.now();
        await enc.write(png);
        hashes.push(createHash('md5').update(png).digest('hex'));
        tStep += b - a; tShot += d - b; tEnc += performance.now() - d;
        if (DEBUG_DIR) {
          const tag = path.join(DEBUG_DIR, String(k).padStart(7, '0'));
          fs.writeFileSync(tag + '-shot.png', png);
          const cv = await page.evaluate(() => window.__R.debug.canvas);
          fs.writeFileSync(tag + '-canvas.png', Buffer.from(cv.split(',')[1], 'base64'));
        }
        const n = k - c.a + 1;
        if (n % (FPS * 30) === 0 || k === c.b - 1) {
          const rate = n / ((Date.now() - t0) / 1000);
          log(`${st.scene} ${(k / FPS).toFixed(0)}s  ${rate.toFixed(1)} fps  (${(n / (c.b - c.a) * 100).toFixed(0)}% of chunk)`
            + `  ms/frame: step ${(tStep / n).toFixed(1)} shot ${(tShot / n).toFixed(1)} enc ${(tEnc / n).toFixed(1)}`);
        }
      }
      await enc.close();
      fs.renameSync(out + '.part.mp4', out);
      fs.writeFileSync(out.replace(/\.mp4$/, '.frames.md5'), hashes.join('\n') + '\n');
      log(`chunk ${c.a}-${c.b} ${st ? st.scene : ''} done: ${c.b - c.a} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } finally {
    await browser.close();
  }
}

function loadPresets() {
  // what GET /show/presets served on the night: the file, minus its _note
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'scene_presets.json'), 'utf8'));
    return Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('_')));
  } catch (e) { return {}; }
}

/* -------------------------------------------------------------------- main */
async function main() {
  ensurePcm();
  const all = chunkList();

  if (IS_WORKER) {
    const a = Number(opt('chunk-from')), b = Number(opt('chunk-to'));
    const mine = all.slice(a, b);
    const srv = await startServer();
    try { await renderRun(mine, srv); } finally { srv.close(); }
    return;
  }

  // contiguous runs of chunks still to do (with --resume, finished ones drop out)
  const todo = all.map((c, i) => ({ ...c, i })).filter((c) => !(flag('resume') && fs.existsSync(chunkFile(c))));
  if (!flag('resume')) for (const c of all) fs.rmSync(chunkFile(c), { force: true });
  if (flag('plan')) {
    for (const c of all) console.log(String(c.a).padStart(7), String(c.b).padStart(7), ((c.b - c.a) / FPS).toFixed(1).padStart(7) + 's', EV.filter((e) => e.frame <= c.a).pop().scene);
  }
  log(`${STAGE}: frames ${FROM}-${TO} (${((TO - FROM) / FPS / 60).toFixed(1)} min) in ${all.length} chunk(s), ${todo.length} to render, ${WORKERS} worker(s)`);

  const runs = [];
  for (const c of todo) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].i === c.i - 1) last.push(c); else runs.push([c]);
  }
  // split the runs into ~WORKERS groups of similar frame count, cutting only at chunk boundaries
  const total = todo.reduce((n, c) => n + c.b - c.a, 0);
  const target = total / WORKERS;
  const jobs = [];
  for (const run of runs) {
    let cur = [], n = 0;
    for (const c of run) {
      if (cur.length && n + (c.b - c.a) / 2 > target && jobs.length + 1 < WORKERS + runs.length) { jobs.push(cur); cur = []; n = 0; }
      cur.push(c); n += c.b - c.a;
    }
    if (cur.length) jobs.push(cur);
  }

  if (flag('plan')) {
    jobs.forEach((j, i) => console.log('job', i, 'chunks', j[0].i, '-', j[j.length - 1].i, 'frames', j[0].a, '-', j[j.length - 1].b,
      ((j[j.length - 1].b - j[0].a) / FPS / 60).toFixed(1) + ' min'));
    return;
  }
  if (jobs.length === 1 && WORKERS === 1) {
    const srv = await startServer();
    try { await renderRun(jobs[0], srv); } finally { srv.close(); }
  } else if (jobs.length) {
    let next = 0, failed = false;
    const runJob = async () => {
      while (next < jobs.length && !failed) {
        const id = next++, job = jobs[id];
        const args = [fileURLToPath(import.meta.url), ...argv.filter((x) => x !== '--resume'), '--worker', '--worker-id', String(id),
          '--chunk-from', String(job[0].i), '--chunk-to', String(job[job.length - 1].i + 1)];
        const child = spawn(process.execPath, args, { stdio: 'inherit' });
        const [code] = await once(child, 'exit');
        if (code !== 0) { failed = true; throw new Error('worker ' + id + ' exited ' + code); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, runJob));
  }

  // lossless concat of the chunks, then the original audio over the top
  const missing = all.filter((c) => !fs.existsSync(chunkFile(c)));
  if (missing.length) throw new Error(missing.length + ' chunk(s) missing — rerun with --resume');
  const listPath = path.join(WORK, 'concat.txt');
  fs.writeFileSync(listPath, all.map((c) => "file '" + chunkFile(c).replace(/'/g, "'\\''") + "'").join('\n') + '\n');
  const outFile = path.resolve(opt('out', path.join(os.homedir(), 'Movies', 'party-mountain-2026', `pm-2026-${STAGE}.mp4`)));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  log('muxing ->', outFile);
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-ss', String(FROM / FPS), '-t', String((TO - FROM) / FPS), '-i', TL.audio_path,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k',
    '-movflags', '+faststart', '-shortest', outFile], { stdio: 'inherit' });
  log('done:', outFile, (fs.statSync(outFile).size / 1e9).toFixed(2) + ' GB');
}

main().catch((err) => { console.error(IS_WORKER ? '[worker]' : '[render]', 'FAILED:', err.stack || err); process.exit(1); });
