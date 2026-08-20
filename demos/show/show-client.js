/* demos/show/show-client.js — the gallery's ?show=1 follower mode
   ============================================================================
   Loaded ONLY when demos.html sees ?show=1, by dynamic import, so a normal
   browse of the gallery never fetches a byte of this and nothing here can run.

   It is a thin client over demos/show/follower_server.py, which holds the
   desired state ("what should the TV be showing") and answers a long poll.
   Three loops, all cheap:

     poll()    GET /show/events?since=SEQ — parks server-side until the state
               moves, so a scene change lands in ~one RTT and an idle show
               costs one open socket. Doubles as the page's heartbeat: the
               server marks the page connected because it is polling.
     drive()   every 250 ms, reconcile the deck against the leader's transport
     report()  every 500 ms, POST /show/page so show-view's VISUALS menu can
               show what is actually on screen, plus live drift

   The deck follows show-view's python player, which is the clock that matters:
   the leader sends (track, position, playing) and this page extrapolates
   position between sends. Small drift is corrected by nudging playbackRate —
   inaudible here anyway, since the TV machine runs at gain 0 — and anything
   past config.drift_seconds is a hard seek.

   Audio never leaves this machine: config.audible is false on the follower and
   the engine's output GainNode sits AFTER the analyser tap, so every frame
   field stays live while the speakers stay silent. */
'use strict';

const BASE = '';                 // same origin: the page is served by the follower
const POLL_ERR_BACKOFF = 1500;

export function initShow(host) {
  const {
    engine, audioEl, selectByName, activeName, syncFull, notice, clearNotice,
    video, refreshPresets, presetsRev,
  } = host;

  let cfg = { audible: false, drift_seconds: 0.25 };
  let logoStyle = null;
  let seq = 0;
  let lastScene = null;
  let logoOn = null;
  /* The cue engine lives in the follower (it owns the transport and the cue
     file), so all this end has to do is render what the state says. `insert`
     is the video-insert window the server has decided is live: {video, at,
     duration}. Its playback position comes from the SAME extrapolated show
     transport as the audio, so the clip pauses, seeks and resumes with the
     set instead of free-running off its own element clock. */
  let insert = null;
  let lastPresetsRev = null;

  // transport as last commanded by the leader, plus when it landed here
  let cmd = { track: null, position: 0, playing: false, duration: 0 };
  let cmdAt = 0;
  let trackKey = null;          // basename currently cued on the deck
  let trackIdx = -1;
  let trackUrl = '';
  let missing = null;           // basename the follower could not find
  let lastDrift = null;
  let statusNote = '';

  /* ------------------------------------------------------------- chrome
     `show` hides the readouts unconditionally; the header and strip come and
     go with real fullscreen (see syncShowFull in demos.html), so a kiosk that
     is filling the TV is clean, and a windowed one still has a FULL button to
     click. */
  document.body.classList.add('show');
  syncFull();

  const logoEl = document.getElementById('showlogo');
  const logoImg = document.getElementById('showlogoimg');

  function applyLogoStyle(s) {
    if (!s || !logoEl) return;
    logoStyle = s;
    if (s.src && logoImg.getAttribute('src') !== s.src) logoImg.src = s.src;
    logoEl.style.setProperty('--logo-scale', String(s.scale != null ? s.scale : 0.34));
    logoEl.style.setProperty('--logo-opacity', String(s.opacity != null ? s.opacity : 0.9));
    logoEl.classList.toggle('breathe', s.breathe !== false);
  }

  function setLogo(on) {
    if (on === logoOn) return;
    logoOn = on;
    if (logoEl) logoEl.classList.toggle('on', !!on);
  }

  /* --------------------------------------------------------- state apply */
  function applyState(st) {
    if (!st) return;
    seq = st.seq || seq;
    if (st.logo_style) applyLogoStyle(st.logo_style);
    if (typeof st.audible === 'boolean') {
      cfg.audible = st.audible;
      engine.setOutputGain(st.audible ? 1 : 0);
    }
    if (st.drift_seconds) cfg.drift_seconds = st.drift_seconds;

    if (st.scene && st.scene !== lastScene) {
      lastScene = st.scene;
      const ok = selectByName(st.scene);
      statusNote = ok ? '' : 'unknown scene ' + st.scene;
      if (!ok) notice('SCENE NOT FOUND', st.scene + ' is not in this gallery build.\n'
        + 'Holding the current scene. Check demos/show/stage_map.json against '
        + 'GET /show/scenes.');
      else clearNotice();
    }
    setLogo(!!st.logo);
    insert = st.video || null;
    pushVideo();          // don't wait up to 250 ms for the next drive() tick

    if (presetsRev && refreshPresets && typeof st.presets_rev === 'number') {
      if (lastPresetsRev === null) lastPresetsRev = st.presets_rev;
      else if (st.presets_rev !== lastPresetsRev) {
        lastPresetsRev = st.presets_rev;
        refreshPresets();
      }
    }

    const t = st.transport || {};
    const changed = t.track !== cmd.track || t.playing !== cmd.playing
      || Math.abs((t.position || 0) - cmd.position) > 0.01;
    if (changed) {
      cmd = {
        track: t.track || null,
        position: +t.position || 0,
        playing: !!t.playing,
        duration: +t.duration || 0,
      };
      cmdAt = performance.now();
    }
  }

  /* ---------------------------------------------------------- long poll */
  async function poll() {
    for (;;) {
      try {
        const r = await fetch(BASE + '/show/events?since=' + seq, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        applyState(await r.json());
      } catch (err) {
        statusNote = 'follower unreachable: ' + (err.message || err);
        await sleep(POLL_ERR_BACKOFF);
      }
    }
  }

  /* -------------------------------------------------------------- deck */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Where the leader's playhead is right now, extrapolated from the last send.
  function targetPos() {
    if (!cmd.playing) return cmd.position;
    return cmd.position + (performance.now() - cmdAt) / 1000;
  }

  async function cueTrack(name) {
    trackKey = name;
    trackIdx = -1;
    missing = null;
    if (!name) return;
    const url = BASE + '/show/audio/' + encodeURIComponent(name);
    try {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!head.ok) throw new Error('HTTP ' + head.status);
    } catch (err) {
      // Keep whatever scene is up and keep rendering on sim/mic — a missing
      // wav must never blank the TV, it just stops the reactions being real.
      missing = name;
      notice('SHOW AUDIO MISSING', name + '\n\nThe follower could not find this file '
        + 'under its configured audio_dir (demos/show/config.json). The scene keeps '
        + 'running on the idle simulation; nothing else is affected.');
      return;
    }
    clearNotice();
    trackUrl = url;
    trackIdx = engine.addTrackUrl(name, url);
  }

  /* ------------------------------------------------------- video inserts */
  const MEDIA_BASE = BASE + '/demos/show/media/';
  const probed = new Map();       // basename -> true (present) | false (404)

  function probeVideo(name) {
    if (probed.has(name)) return;
    probed.set(name, null);       // in flight
    fetch(MEDIA_BASE + encodeURIComponent(name), { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        probed.set(name, r.ok);
        if (!r.ok) statusNote = 'video insert missing: ' + name;
      })
      .catch(() => { probed.set(name, false); statusNote = 'video insert missing: ' + name; });
  }

  /* A missing clip must never black out the TV: the scene is already running
     underneath, so the honest failure mode is simply not raising the overlay. */
  let videoState = null;      // what the element is actually doing, for report()

  function pushVideo() {
    if (!video) return;
    if (!insert || !insert.video) { videoState = video(null); return; }
    const name = insert.video;
    probeVideo(name);
    if (probed.get(name) === false) { videoState = video(null); return; }
    videoState = video({
      url: MEDIA_BASE + encodeURIComponent(name),
      t: Math.max(0, targetPos() - (insert.at || 0)),
      playing: cmd.playing,
    });
  }

  let cueing = null;
  function drive() {
    pushVideo();
    if (cmd.track !== trackKey && !cueing) {
      cueing = cueTrack(cmd.track).finally(() => { cueing = null; });
      return;
    }
    if (missing || trackIdx < 0 || cueing) return;

    // loadTracks() can replace the deck array out from under us; re-add rather
    // than play whatever landed on the old index
    const cur = engine.tracks[trackIdx];
    if (!cur || cur.url !== trackUrl) { trackIdx = engine.addTrackUrl(trackKey, trackUrl); }

    if (!cmd.playing) {
      if (!audioEl.paused) audioEl.pause();
      lastDrift = null;
      audioEl.playbackRate = 1;
      // a paused leader still owns the playhead (it seeks while stopped)
      if (engine.currentTrack === trackIdx
          && Math.abs(audioEl.currentTime - cmd.position) > 0.3) {
        audioEl.currentTime = cmd.position;
      }
      return;
    }

    if (engine.currentTrack !== trackIdx || audioEl.paused) {
      engine.playTrack(trackIdx);
      // the element may not have metadata yet; the next tick does the seek
      return;
    }
    if (!audioEl.duration) return;

    const d = targetPos() - audioEl.currentTime;
    lastDrift = d;
    const limit = cfg.drift_seconds || 0.25;
    if (Math.abs(d) > limit) {
      audioEl.playbackRate = 1;
      audioEl.currentTime = Math.max(0, Math.min(targetPos(), audioEl.duration - 0.05));
    } else if (Math.abs(d) > 0.05) {
      // gentle rate nudge: ±4% closes a 0.2 s gap in ~5 s without a jump
      audioEl.playbackRate = 1 + Math.max(-0.04, Math.min(0.04, d * 0.25));
    } else {
      audioEl.playbackRate = 1;
    }
  }

  /* ------------------------------------------------------------ report */
  let frameLevel = 0;
  function noteFrame(f) { frameLevel = f ? f.level : 0; }

  async function report() {
    const body = {
      scene: activeName(),
      logo: !!logoOn,
      insert: insert ? insert.video : null,
      video: videoState,
      track: trackKey,
      playing: !audioEl.paused && engine.currentTrack === trackIdx,
      position: Math.round((audioEl.currentTime || 0) * 100) / 100,
      drift: lastDrift == null ? null : Math.round(lastDrift * 1000) / 1000,
      rate: audioEl.playbackRate,
      level: Math.round(frameLevel * 1000) / 1000,
      mode: engine.mode,
      audible: cfg.audible,
      gain: engine.outputGain,
      missing,
      note: statusNote,
      // is the TV actually filled? kiosk Chrome is window-fullscreen, which
      // the Fullscreen API does not report, so compare the two directly —
      // this is the only way to see a letterboxed TV from the other machine
      fs: !!document.fullscreenElement,
      imm: document.body.classList.contains('immersive'),
      pulse: document.getElementById('pulseBtn').classList.contains('toggled'),
      view: [innerWidth, innerHeight],
      screen: [screen.width, screen.height],
    };
    try {
      await fetch(BASE + '/show/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) { /* the follower will notice by page_age */ }
  }

  /* -------------------------------------------------------------- boot */
  fetch(BASE + '/show/status', { cache: 'no-store' })
    .then((r) => r.json()).then(applyState).catch(() => {});
  poll();
  setInterval(drive, 250);
  setInterval(report, 500);

  console.log('[show] follower client up');
  return { noteFrame };
}
