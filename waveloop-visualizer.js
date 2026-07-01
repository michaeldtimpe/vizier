/* waveloop — wheel visualizer
   ============================================================================
   The reference visualization, extracted from the original waveloop.html. It
   consumes ChromaFrames from the AnalysisEngine (see waveloop-analysis.js) and
   knows NOTHING about audio, FFTs, or DSP — only how to draw a pitch-class
   field. Use it as-is, or copy its shape as a template for your own viz.

   A visualizer is any object with:
       resize()                  fit the backing canvas to its CSS size
       render(frame, now, dt)    draw one ChromaFrame
   Construct one per <canvas>. To add your own, implement those two methods
   against the ChromaFrame contract and swap it into the host's render loop.

   What this one does: a CRT pitch-class wheel. angle = pitch class (A at top,
   ascending clockwise); the engine's per-band energy is rasterized CPU-side
   into a radial trail map where each history row flies outward at a speed set
   by its own amplitude (loud shoots for the corners, quiet lingers by the
   ring), with a leading rim that stacks simultaneous octaves of a pitch class
   into a continuous Oklch register gradient.
   ========================================================================== */

'use strict';

import { SPEC } from './waveloop-analysis.js';

const { ANG, NREG, RIM_REGS, OCT_SPAN, E_MAX } = SPEC;

// angular supersample of the trail map so the CPU raster can lerp row geometry
// between analysis bins (4x on desktop; 2x on small screens / few-core devices,
// where the per-push raster cost and 4 MB uploads would bite)
const AOS = (Math.min(screen.width, screen.height) < 700
          || (navigator.hardwareConcurrency || 8) <= 4) ? 2 : 4;
const ANG_TEX = ANG * AOS;                  // trail map width (shader ANGC)

const RBINS = 256;                          // radial bins per band in the trail map
const HIST_ROWS = 256;                      // history rows per angle/band
const RIMT = 64;                            // rim texture height (stack-fraction texels)
const TRAIL_SECONDS = 5;
const ROW_DT = TRAIL_SECONDS / HIST_ROWS;   // ~19.5 ms per row

/* ------------------------------------------------------------------ shaders */

const VERT = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;    // smoothed overall energy 0..1
uniform float u_beat;     // beat pulse envelope 0..1
uniform float u_guides;   // 1 = draw the spokes + semitone ticks, 0 = hide them
uniform sampler2D u_hist; // ANG x (RBINS*REGS) RGBA radial trail map, CPU-rasterized
uniform sampler2D u_rim;  // ANG x RIMT luminance: register at stack fraction

const float TAU = 6.28318530718;
const float ANGC = ${ANG_TEX}.0;  // trail map angular width, ANG * AOS
const float ANGN = ${ANG}.0;      // rim register texture width (no supersample)
const float RBINS = 256.0;
const float REGS = 4.0;
const float TROWS = RBINS * REGS;
const float R0 = 0.19;   // base ring radius (fraction of min dimension)
const float RT = 0.40;   // semitone tick radius (the old trail edge)
const float EMAX = ${E_MAX.toFixed(1)};  // display-energy ceiling; alpha stores sqrt(v / EMAX)
const float OCTS = ${OCT_SPAN.toFixed(4)};  // octaves 20 Hz..20 kHz (OCT_SPAN)
const float RIMT = ${RIMT}.0; // rim texture height (stack-fraction texels)

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

/* cubic B-spline reconstruction across w angular columns, folded into two
   hardware LINEAR taps. tap S-coordinates in .x/.y, left-tap weight in .z. */
vec3 bspline(float pc01, float w) {
  float pcT = pc01 * w - 0.5;
  float ip = floor(pcT);
  float f = pcT - ip;
  float f2 = f * f, f3 = f2 * f;
  float w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  float w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  float w3 = f3 / 6.0;
  float g0 = w0 + w1;
  return vec3((ip - 0.5 + w1 / g0) / w,
              (ip + 1.5 + w3 / (1.0 - g0)) / w, g0);
}

/* sample one band's block of the radial trail map at normalized radius xr. */
vec4 radAt(vec3 ang, float xr, float band) {
  float y = (clamp(xr, 0.0, 1.0) * (RBINS - 1.0) + 0.5 + band * RBINS) / TROWS;
  return mix(texture2D(u_hist, vec2(ang.y, y)),
             texture2D(u_hist, vec2(ang.x, y)), ang.z);
}

/* register (0..1 over 20 Hz..20 kHz) found at stack fraction t of this angle's
   live energy, off the rim inverse-CDF texture. */
float regAt(vec3 ang, float t) {
  float y = (t * (RIMT - 1.0) + 0.5) / RIMT;
  return mix(texture2D(u_rim, vec2(ang.y, y)),
             texture2D(u_rim, vec2(ang.x, y)), ang.z).r;
}

/* continuous register ramp: Oklch with hue advancing ~60 degrees per octave,
   lightness climbing the whole register axis, chroma peaking near C4. */
vec3 regColor(float o) {
  float h = (24.0 + o * OCTS * 60.0) * 0.01745329;
  float t = (o - 0.37) / 0.30;
  float C = 0.05 + 0.145 * exp(-t * t);
  float L = 0.30 + 0.63 * o;
  float a = C * cos(h), b = C * sin(h);
  float l = L + 0.3963377774 * a + 0.2158037573 * b;
  float m = L - 0.1055613458 * a - 0.0638541728 * b;
  float s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l; m = m * m * m; s = s * s * s;
  vec3 rgb = vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                  -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                  -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return pow(clamp(rgb, 0.0, 1.0), vec3(0.4545));
}

void main() {
  float mn = min(u_res.x, u_res.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / mn;
  float r = length(uv);
  float pc01 = fract(atan(uv.x, uv.y) / TAU); // 0 = A at top, ascending clockwise

  vec3 ang = bspline(pc01, ANGC);
  vec3 angN = bspline(pc01, ANGN);

  vec3 phos  = vec3(0.27, 1.0, 0.78);
  vec3 cold  = vec3(0.10, 0.35, 0.50);

  vec3 col = vec3(0.012, 0.022, 0.028);

  // drifting aurora backdrop, brightened by energy
  float n = fbm(uv * 2.4 + vec2(u_time * 0.04, -u_time * 0.025));
  float n2 = fbm(uv * 5.0 - vec2(u_time * 0.06, 0.0));
  col += cold * n * (0.07 + 0.38 * u_level);
  col += phos * n * n2 * 0.22 * u_level;

  // 12 radial spokes through the chromatic note positions
  float sectDist = abs(fract(pc01 * 12.0 + 0.5) - 0.5) / 12.0;
  float arcDist = sectDist * TAU * max(r, 0.001);
  float spoke = exp(-arcDist * arcDist * 1.2e5);
  col += phos * spoke * smoothstep(0.0, 0.04, r - (R0 + 0.01))
       * (1.0 - 0.6 * smoothstep(0.46, 0.85, r)) * 0.05 * u_guides;

  float r0 = R0 + 0.008 * u_beat;

  // --- history trails, one per register band, read off the radial trail map
  float rOut = 0.5 * length(u_res) / mn + 0.03;
  float xr = clamp((r - r0) / (rOut - r0), 0.0, 1.0);
  float trailMask = smoothstep(0.0, 0.008, r - r0);
  for (int j = 0; j < 4; j++) {
    vec4 h = radAt(ang, xr, float(j));
    float ha = h.a * h.a * EMAX;
    col += h.rgb * h.a * EMAX * (0.55 + 0.95 * ha) * trailMask;
  }

  // --- leading rim: stacked histogram of the current energy at each angle
  vec4 hn[4];
  float eTot = 0.0;
  for (int j = 0; j < 4; j++) {
    hn[j] = radAt(ang, 0.0, float(j));
    eTot += hn[j].a * hn[j].a * EMAX;
  }
  float s2 = eTot * eTot;
  float stackH = 0.006 + 0.30 * s2 / (s2 + 4.0);
  float xo = r - r0;
  float aa = 0.003;
  float stk = smoothstep(-aa, aa, xo) - smoothstep(stackH - aa, stackH + aa, xo);
  if (stk > 0.001) {
    float bright = 0.25 + 0.85 * min(eTot, 2.2);
    col += regColor(regAt(angN, clamp(xo / stackH, 0.0, 1.0))) * stk * bright;
  }

  // base ring glow: dim phosphor on silent spokes, adopting the live chroma
  float ringGlow = exp(-abs(r - r0) * 70.0);
  float occupied = clamp(eTot * 4.0, 0.0, 1.0);
  vec3 sumRgb = (hn[0].rgb * hn[0].a + hn[1].rgb * hn[1].a
               + hn[2].rgb * hn[2].a + hn[3].rgb * hn[3].a) * EMAX;
  vec3 ringCol = mix(phos * (0.06 + 0.13 * u_level),
                     sumRgb * (0.5 + 0.5 * u_level), occupied);
  col += ringCol * ringGlow;

  // --- semitone tick marks at a fixed radius on the same spokes
  float tickBand = smoothstep(0.0, 0.004, r - (RT + 0.012))
                 * smoothstep(0.0, 0.004, (RT + 0.028) - r);
  col += phos * exp(-arcDist * arcDist * 2.0e5) * tickBand * 0.55 * u_guides;

  // hue-preserving limiter
  float peak = max(col.r, max(col.g, col.b));
  if (peak > 0.82) {
    col *= (0.82 + 0.18 * (1.0 - exp((0.82 - peak) / 0.18))) / peak;
  }

  // grain + vignette
  col *= 1.0 - 0.22 * smoothstep(0.75, 1.45, r);
  col += (hash(uv * 711.0 + fract(u_time)) - 0.5) * 0.025;

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ----------------------------------------------------- amplitude->speed ramp */
const SPD_MIN = 0.15;   // radial speed of near-silent rows
const SPD_MAX = 1.25;   // radial speed of full-scale rows
const TIP_FEATHER = 4.0; // bins of falloff past each column's leading edge

function rowSpeed(s) {
  const s3 = s * s * s;
  return SPD_MIN + (SPD_MAX - SPD_MIN) * s3 / (s3 + 0.25);
}

// age warps (read-only, shared across instances)
const warpLut = new Float32Array(HIST_ROWS);  // age01^(1/2.2): concave radius warp
const fadeLut = new Float32Array(HIST_ROWS);   // gentle fade; rows die at max age
for (let k = 0; k < HIST_ROWS; k++) {
  const age01 = k / (HIST_ROWS - 1);
  warpLut[k] = Math.pow(age01, 1 / 2.2);
  fadeLut[k] = Math.pow(1 - age01, 1.25);
}

/* ============================================================ visualizer */

export class WheelVisualizer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false })
            || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable');

    /* --- program --- */
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const locP = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(locP);
    gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 0, 0);

    const U = {};
    for (const name of ['u_res', 'u_time', 'u_level', 'u_beat', 'u_guides', 'u_hist', 'u_rim']) {
      U[name] = gl.getUniformLocation(prog, name);
    }

    /* --- trail map texture + CPU ring buffers --- */
    const histTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, histTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ANG_TEX, RBINS * NREG, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(ANG_TEX * RBINS * NREG * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.uniform1i(U.u_hist, 0);

    /* --- rim color texture (register at stack fraction) --- */
    const rimPix = new Uint8Array(RIMT * ANG);
    for (let t = 0; t < RIMT; t++) {
      rimPix.fill((t + 0.5) / RIMT * 255 + 0.5, t * ANG, (t + 1) * ANG);
    }
    const rimTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rimTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, ANG, RIMT, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, rimPix);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U.u_rim, 1);
    gl.activeTexture(gl.TEXTURE0);

    // ring buffers laid out (band, angle, row); energy snaps to exact zero
    // below a floor so silent columns are cheap to skip
    const histE = new Float32Array(NREG * ANG * HIST_ROWS);
    const histS = new Float32Array(NREG * ANG * HIST_ROWS); // smoothed speed amplitude
    const histR = new Float32Array(NREG * ANG * HIST_ROWS);
    const histG = new Float32Array(NREG * ANG * HIST_ROWS);
    const histB = new Float32Array(NREG * ANG * HIST_ROWS);
    const colCount = new Uint16Array(NREG * ANG);

    // peak-hold of the display state between history-row pushes
    const rowPeakE = new Float32Array(NREG * ANG);
    const rowPeakR = new Float32Array(NREG * ANG);
    const rowPeakG = new Float32Array(NREG * ANG);
    const rowPeakB = new Float32Array(NREG * ANG);

    // raster scratch
    const segX = new Float32Array(HIST_ROWS);
    const segV = new Float32Array(HIST_ROWS);
    const segR = new Float32Array(HIST_ROWS);
    const segG = new Float32Array(HIST_ROWS);
    const segB = new Float32Array(HIST_ROWS);
    const radCol = new Float32Array(RBINS * 4);
    const radPix = new Uint8Array(ANG_TEX * RBINS * NREG * 4);
    const radHi = new Uint16Array(NREG * ANG_TEX);
    const geomX = new Float32Array(ANG * HIST_ROWS);
    const geomV = new Float32Array(ANG * HIST_ROWS);
    const geomR = new Float32Array(ANG * HIST_ROWS);
    const geomG = new Float32Array(ANG * HIST_ROWS);
    const geomB = new Float32Array(ANG * HIST_ROWS);
    const colNeed = new Uint8Array(ANG);
    const colLive = new Uint8Array(ANG);

    let histHead = 0;
    let lastRowAt = -1;
    let radTouched = true;
    let guides = 1;            // 1 = spokes + ticks drawn, 0 = hidden (see setGuides)

    /* --- amplitude-driven trail raster (two passes per band) --- */
    const rasterTrails = () => {
      const am = ANG - 1;
      for (let jr = 0; jr < NREG; jr++) {
        const cbase = jr * ANG;
        for (let a = 0; a < ANG; a++) {
          colNeed[a] = (colCount[cbase + a] || colCount[cbase + ((a - 1) & am)]
                     || colCount[cbase + ((a + 1) & am)]) ? 1 : 0;
        }
        for (let a = 0; a < ANG; a++) {
          colLive[a] = 0;
          if (!colNeed[a]) continue;
          const hbase = (cbase + a) * HIST_ROWS;
          const sbase = a * HIST_ROWS;
          let row = histHead, any = false;
          for (let k = 0; k < HIST_ROWS; k++) {
            const o = hbase + row;
            row = row === 0 ? HIST_ROWS - 1 : row - 1;
            geomX[sbase + k] = rowSpeed(histS[o]) * warpLut[k] * (RBINS - 1);
            const v = histE[o] * fadeLut[k];
            if (v > 0.016) {
              geomV[sbase + k] = v;
              geomR[sbase + k] = histR[o] * v;
              geomG[sbase + k] = histG[o] * v;
              geomB[sbase + k] = histB[o] * v;
              any = true;
            } else {
              geomV[sbase + k] = 0;
              geomR[sbase + k] = geomG[sbase + k] = geomB[sbase + k] = 0;
            }
          }
          if (any) colLive[a] = 1;
        }
        for (let s = 0; s < ANG_TEX; s++) {
          const li = jr * ANG_TEX + s;
          const prevHi = radHi[li];
          const pCol = (s + 0.5) / AOS;
          const a0 = Math.floor(pCol) & am;
          const a1 = (a0 + 1) & am;
          if (!colLive[a0] && !colLive[a1]) {
            if (prevHi > 0) {
              radHi[li] = 0;
              radTouched = true;
              for (let b = 0; b < prevHi; b++) {
                const dst = (((jr * RBINS + b) * ANG_TEX) + s) * 4;
                radPix[dst] = radPix[dst + 1] = radPix[dst + 2] = radPix[dst + 3] = 0;
              }
            }
            continue;
          }
          const tt = pCol - Math.floor(pCol);
          const bA = a0 * HIST_ROWS, bB = a1 * HIST_ROWS;
          let hiX = 0, tipK = -1, any = false;
          for (let k = 0; k < HIST_ROWS; k++) {
            const xA = geomX[bA + k];
            const x = xA + (geomX[bB + k] - xA) * tt;
            const vA = geomV[bA + k];
            const v = vA + (geomV[bB + k] - vA) * tt;
            segX[k] = x;
            if (v > 1e-4) {
              segV[k] = v;
              const rA = geomR[bA + k], gA = geomG[bA + k], bbA = geomB[bA + k];
              segR[k] = rA + (geomR[bB + k] - rA) * tt;
              segG[k] = gA + (geomG[bB + k] - gA) * tt;
              segB[k] = bbA + (geomB[bB + k] - bbA) * tt;
              if (x > hiX) { hiX = x; tipK = k; }
              any = true;
            } else {
              segV[k] = segR[k] = segG[k] = segB[k] = 0;
            }
          }
          const hi = any ? Math.min(Math.round(hiX + TIP_FEATHER) + 1, RBINS - 1) : 0;
          if (!any && prevHi === 0) continue;
          radTouched = true;
          for (let b = 0; b <= hi; b++) {
            const ci = b * 4;
            radCol[ci] = radCol[ci + 1] = radCol[ci + 2] = radCol[ci + 3] = 0;
          }
          for (let k = 0; k + 1 < HIST_ROWS; k++) {
            const vA = segV[k], vB = segV[k + 1];
            if (vA <= 0 && vB <= 0) continue;
            const xA = segX[k], xB = segX[k + 1];
            let b0 = Math.round(Math.min(xA, xB));
            let b1 = Math.round(Math.max(xA, xB));
            if (b0 < 0) b0 = 0;
            if (b1 > hi) b1 = hi;
            const dx = xB - xA;
            const inv = Math.abs(dx) > 1e-6 ? 1 / dx : 0;
            const dv = vB - vA;
            const dR = segR[k + 1] - segR[k];
            const dG = segG[k + 1] - segG[k];
            const dB = segB[k + 1] - segB[k];
            for (let b = b0; b <= b1; b++) {
              let t = (b - xA) * inv;
              if (t < 0) t = 0; else if (t > 1) t = 1;
              const v = vA + dv * t;
              const ci = b * 4;
              if (v > radCol[ci + 3]) {
                radCol[ci + 3] = v;
                radCol[ci]     = segR[k] + dR * t;
                radCol[ci + 1] = segG[k] + dG * t;
                radCol[ci + 2] = segB[k] + dB * t;
              }
            }
          }
          // feather the leading edge
          if (tipK >= 0) {
            const tv = segV[tipK];
            const pr = segR[tipK] / tv, pg = segG[tipK] / tv, pb = segB[tipK] / tv;
            for (let b = Math.max(0, Math.ceil(hiX)); b <= hi; b++) {
              const t = (b - hiX) / TIP_FEATHER;
              if (t <= 0) continue;
              if (t >= 1) break;
              const v = tv * (1 - t) * Math.sqrt(1 - t);
              const ci = b * 4;
              if (v > radCol[ci + 3]) {
                radCol[ci + 3] = v;
                radCol[ci] = pr * v; radCol[ci + 1] = pg * v; radCol[ci + 2] = pb * v;
              }
            }
          }
          // quantize the lit span (alpha sqrt-encoded against E_MAX)
          const top = Math.max(hi, prevHi);
          for (let b = 0; b <= top; b++) {
            const dst = (((jr * RBINS + b) * ANG_TEX) + s) * 4;
            const v = b <= hi ? radCol[b * 4 + 3] : 0;
            if (v > 1e-6) {
              const ci = b * 4;
              // contrast knee (bin 0 stays raw for the rim's exact proportions)
              const vk = b === 0 ? v : v * v * v / (v * v + 0.02);
              const aEnc = Math.min(Math.sqrt(vk / E_MAX), 1);
              const cs = aEnc / v * 255;
              radPix[dst]     = Math.min(255, radCol[ci]     * cs) | 0;
              radPix[dst + 1] = Math.min(255, radCol[ci + 1] * cs) | 0;
              radPix[dst + 2] = Math.min(255, radCol[ci + 2] * cs) | 0;
              radPix[dst + 3] = (aEnc * 255) | 0;
            } else {
              radPix[dst] = radPix[dst + 1] = radPix[dst + 2] = radPix[dst + 3] = 0;
            }
          }
          radHi[li] = hi;
        }
      }
      if (radTouched) {
        radTouched = false;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ANG_TEX, RBINS * NREG,
          gl.RGBA, gl.UNSIGNED_BYTE, radPix);
      }
    };

    /* --- public methods --- */
    this.resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    this.render = (frame, now, dt) => {
      const energy = frame.energy, fr = frame.r, fg = frame.g, fb = frame.b;

      // peak-hold the incoming display state: on high-refresh displays several
      // frames land in one history row; keep the brightest so transients survive
      for (let i = 0; i < NREG * ANG; i++) {
        if (energy[i] > rowPeakE[i]) {
          rowPeakE[i] = energy[i];
          rowPeakR[i] = fr[i]; rowPeakG[i] = fg[i]; rowPeakB[i] = fb[i];
        }
      }

      this.resize();

      // push history rows at a fixed cadence so trail speed is time-accurate
      if (lastRowAt < 0) lastRowAt = now;
      if (now - lastRowAt > TRAIL_SECONDS) lastRowAt = now - ROW_DT;
      let pushed = false;
      while (now - lastRowAt >= ROW_DT) {
        lastRowAt += ROW_DT;
        pushed = true;
        histHead = (histHead + 1) % HIST_ROWS;
        const am = ANG - 1;
        for (let jr = 0; jr < NREG; jr++) {
          const rb = jr * ANG;
          for (let a = 0; a < ANG; a++) {
            const i = rb + a;
            const o = i * HIST_ROWS + histHead;
            const e = rowPeakE[i] >= 0.002 ? rowPeakE[i] : 0;
            if (histE[o] > 0) colCount[i]--;
            if (e > 0) colCount[i]++;
            histE[o] = e;
            // radial SPEED reads a binomial-smoothed (sigma ~1 bin) copy of the
            // amplitude so neighboring columns of one note travel together
            histS[o] = (rowPeakE[rb + ((a - 2) & am)] + 4 * rowPeakE[rb + ((a - 1) & am)]
                      + 6 * rowPeakE[i] + 4 * rowPeakE[rb + ((a + 1) & am)]
                      + rowPeakE[rb + ((a + 2) & am)]) * 0.0625;
            histR[o] = rowPeakR[i]; histG[o] = rowPeakG[i]; histB[o] = rowPeakB[i];
          }
        }
        rowPeakE.set(energy);
        rowPeakR.set(fr); rowPeakG.set(fg); rowPeakB.set(fb);
      }

      // row pushes are the only thing that moves the trail field (ages, and so
      // radii, advance one row at a time), so only re-raster on a push
      if (pushed) rasterTrails();

      // rim color texture: invert each angle's smoothed register distribution
      // into register-at-stack-fraction texels. Silent angles keep their last
      // partition so the dim residual stack holds its colors while it fades.
      const rim = frame.rim;
      for (let a = 0; a < ANG; a++) {
        let tot = 0;
        for (let k = 0; k < RIM_REGS; k++) tot += rim[k * ANG + a];
        if (tot < 1e-9) continue;
        let k = 0, cum = rim[a];
        for (let t = 0; t < RIMT; t++) {
          const target = (t + 0.5) / RIMT * tot;
          while (cum < target && k < RIM_REGS - 1) { k++; cum += rim[k * ANG + a]; }
          const e = rim[k * ANG + a];
          const frac = e > 0 ? 1 - (cum - target) / e : 0.5;
          rimPix[t * ANG + a] = (k + frac) / RIM_REGS * 255 + 0.5;
        }
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ANG, RIMT,
        gl.LUMINANCE, gl.UNSIGNED_BYTE, rimPix);
      gl.activeTexture(gl.TEXTURE0);

      gl.uniform2f(U.u_res, canvas.width, canvas.height);
      gl.uniform1f(U.u_time, now);
      gl.uniform1f(U.u_level, frame.level);
      gl.uniform1f(U.u_beat, frame.beat);
      gl.uniform1f(U.u_guides, guides);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // toggle the wheel guide lines (12 radial spokes + semitone ticks)
    this.setGuides = (on) => { guides = on ? 1 : 0; };
    this.getGuides = () => guides === 1;

    this.dispose = () => {
      gl.deleteTexture(histTex);
      gl.deleteTexture(rimTex);
      gl.deleteBuffer(quad);
      gl.deleteProgram(prog);
    };
  }
}
