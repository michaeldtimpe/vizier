/* Synesthesia SSF standard library, ported to GLSL ES 3.00
   ============================================================================
   Synesthesia prepends a ~20 KB fixed preamble to every scene's main.glsl: the
   `_`-prefixed helper functions (`_pulse`, `_rotate`, `_hsv2rgb`, `_fbm`, the
   `_loadImage` family, ...) that scene authors call without declaring. Scenes
   are unrunnable without it, so this is a faithful transcription of that
   preamble — recovered verbatim from the shipped desktop binary — with the
   desktop-GLSL-isms fixed so it compiles as GLSL ES 3.00.

   What had to change, and why (all verified against a real WebGL2 compile):

     * `#version 330` has implicit int -> float promotion; ES 3.00 does NOT.
       The stock preamble leans on it everywhere (`posIn *= 2`, `clamp(r,0,255)`,
       `mod(floor(x), 2) == 1`, `float shift = float(100)`, and a `_fbm` loop
       whose bound `octaves` is a float). Every such literal is now spelled as
       a float, and the `_fbm` loop compares `float(i) < octaves`.
     * `textureSize()` returns ivec2; the stock `IMG_SIZE`/`_mediaSize` return
       it as a vec2 by implicit conversion. Now an explicit `vec2(...)`.
     * ES 3.00 forbids NON-CONSTANT global initializers, which is how the stock
       preamble defines `_xy`/`_uv`/`_uvc` (from gl_FragCoord). They are
       declared bare here and assigned in `_initGlobals()`, which syn-runtime.js
       emits at the end of the shader and calls first thing in main(). Scene
       code with the same habit gets hoisted into the same function.
     * `sampler1D` does not exist in ES 3.00, so `syn_Spectrum`/`syn_LevelTrail`
       are 1-row `sampler2D`s and syn-runtime.js rewrites their call sites.

   Deliberately omitted: the Syphon `sampler2DRect` pass, and the app's private
   `-1..-4` post-processing passes. Neither is reachable from scene code.
   ========================================================================== */

'use strict';

/* Position globals + PI. Declared (not initialized) up front because scene code
   may reference them from its own hoisted global initializers. */
export const GLSL_GLOBALS = `
vec2 _xy;
vec2 _uv;
vec2 _uvc;
const float PI = 3.14159265359;
`;

/* Assignments for the above; syn-runtime.js splices this into _initGlobals()
   ahead of anything it hoists out of the scene. */
export const GLSL_GLOBAL_INIT = `
  _xy = gl_FragCoord.xy;
  _uv = _xy / RENDERSIZE.xy;
  _uvc = _xy / RENDERSIZE.y - vec2(RENDERSIZE.x / RENDERSIZE.y / 2.0, 0.5);
`;

/* ------------------------------------------------------ coordinates + math */
const LIB_MATH = `
vec2 _toPolar(vec2 v) { return vec2(length(v), atan(v.y / v.x)); }
vec2 _toPolarTrue(vec2 uv) {
  float r = length(uv); float theta = 0.0;
  float real = uv.x; float imag = uv.y;
  if (real > 0.0 && imag >= 0.0) theta = atan(imag / real);
  if (real <= 0.0 && imag > 0.0) theta = -1.0 * atan(real / imag) + PI / 2.0;
  if (real < 0.0 && imag <= 0.0) theta = atan(imag / real) + PI;
  if (real >= 0.0 && imag < 0.0) theta = -1.0 * atan(real / imag) + 3.0 * PI / 2.0;
  theta = theta / (2.0 * PI);
  return vec2(r, theta);
}
vec2 _toRect(vec2 v) { return vec2(v.r * cos(v.t), v.r * sin(v.t)); }
vec2 _rotate(vec2 v, float t) { mat2 T = mat2(cos(t), -sin(t), sin(t), cos(t)); return T * v; }
void _uvc2uv(inout vec2 posIn) { posIn *= 0.5; posIn += 0.5; }
void _uv2uvc(inout vec2 posIn) { posIn *= 2.0; posIn -= 1.0; }

float _scale(float var_, float min_, float max_) { return var_ * (max_ - min_) + min_; }
float _map(float value, float min_, float max_, float new_min, float new_max) {
  return new_min + (value - min_) * (new_max - new_min) / (max_ - min_); }
vec2 _map(vec2 value, vec2 min_, vec2 max_, vec2 new_min, vec2 new_max) {
  return new_min + (value - min_) * (new_max - new_min) / (max_ - min_); }
vec3 _map(vec3 value, vec3 min_, vec3 max_, vec3 new_min, vec3 new_max) {
  return new_min + (value - min_) * (new_max - new_min) / (max_ - min_); }
vec4 _map(vec4 value, vec4 min_, vec4 max_, vec4 new_min, vec4 new_max) {
  return new_min + (value - min_) * (new_max - new_min) / (max_ - min_); }

float _smin(float a, float b, float k) { float res = exp(-k * a) + exp(-k * b); return -log(res) / k; }
float _pixelate(float x, float amount) { return floor(x * amount) / amount; }
vec2 _pixelate(vec2 x, float amount) { return floor(x * amount) / amount; }
vec3 _pixelate(vec3 x, float amount) { return floor(x * amount) / amount; }

float _pulse(float variable, float center, float width) {
  return (smoothstep(center - width, center, variable) - (smoothstep(center, center + width, variable))); }
float _sqPulse(float variable, float center, float width) {
  return step(center - width, variable) - step(center + width, variable); }

float _inRange(float value, float minimum, float maximum) { return step(minimum, value) - step(maximum, value); }
float _inRange(vec2 value, float mn, float mx) { return _inRange(value.x, mn, mx) * _inRange(value.y, mn, mx); }
float _inRange(vec3 value, float mn, float mx) { return _inRange(value.x, mn, mx) * _inRange(value.y, mn, mx) * _inRange(value.z, mn, mx); }
float _inRange(vec4 value, float mn, float mx) { return _inRange(value.x, mn, mx) * _inRange(value.y, mn, mx) * _inRange(value.z, mn, mx) * _inRange(value.w, mn, mx); }
float _inRange(float v) { return _inRange(v, 0.0, 1.0); }
float _inRange(vec2 v) { return _inRange(v, 0.0, 1.0); }
float _inRange(vec3 v) { return _inRange(v, 0.0, 1.0); }
float _inRange(vec4 v) { return _inRange(v, 0.0, 1.0); }

float _triWave(float var_, float period) {
  float up = (abs(mod(var_, period)) - period / 2.0) / period;
  float down = (abs(mod(-var_, period)) - period / 2.0) / period;
  if (mod(var_, period) < period / 2.0) { return up; } else { return down; }
}
float _nsin(float valIn) { return 0.5 + 0.5 * sin(valIn); }
float _ncos(float valIn) { return 0.5 + 0.5 * cos(valIn); }
float _nclamp(float v) { return clamp(v, 0.0, 1.0); }
vec2 _nclamp(vec2 v) { return clamp(v, vec2(0.0), vec2(1.0)); }
vec3 _nclamp(vec3 v) { return clamp(v, vec3(0.0), vec3(1.0)); }
vec4 _nclamp(vec4 v) { return clamp(v, vec4(0.0), vec4(1.0)); }

float _mirror(float x) { if (mod(floor(x), 2.0) == 1.0) x = 1.0 - x; return mod(x, 1.0); }
vec2 _mirror(vec2 p) { p.x = _mirror(p.x); p.y = _mirror(p.y); return p; }
vec3 _mirror(vec3 p) { p.x = _mirror(p.x); p.y = _mirror(p.y); p.z = _mirror(p.z); return p; }
vec4 _mirror(vec4 p) { p.x = _mirror(p.x); p.y = _mirror(p.y); p.z = _mirror(p.z); p.w = _mirror(p.w); return p; }

float _statelessContinuousChaotic(float t) {
  float primes[10] = float[](2.0, 3.0, 5.0, 7.0, 11.0, 13.0, 17.0, 19.0, 23.0, 29.0);
  float chaosTotal = 0.0;
  for (int i = 0; i < 10; i++) { chaosTotal += float(i) * sin(primes[i] * t); }
  return sin(chaosTotal);
}
bool _exists(sampler2D tex) { ivec2 size = textureSize(tex, 0); return !(size.x <= 1 && size.y <= 1); }

float _mix3(float a, float b, float c, float m) { m *= 2.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); return mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); }
vec2 _mix3(vec2 a, vec2 b, vec2 c, float m) { m *= 2.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); return mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); }
vec3 _mix3(vec3 a, vec3 b, vec3 c, float m) { m *= 2.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); return mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); }
vec4 _mix3(vec4 a, vec4 b, vec4 c, float m) { m *= 2.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); return mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); }
float _mix4(float a, float b, float c, float d, float m) { m *= 3.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); float ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); return mix(ft, mix(c, d, m3), step(2.0, m)); }
vec2 _mix4(vec2 a, vec2 b, vec2 c, vec2 d, float m) { m *= 3.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); vec2 ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); return mix(ft, mix(c, d, m3), step(2.0, m)); }
vec3 _mix4(vec3 a, vec3 b, vec3 c, vec3 d, float m) { m *= 3.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); vec3 ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); return mix(ft, mix(c, d, m3), step(2.0, m)); }
vec4 _mix4(vec4 a, vec4 b, vec4 c, vec4 d, float m) { m *= 3.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); vec4 ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); return mix(ft, mix(c, d, m3), step(2.0, m)); }
float _mix5(float a, float b, float c, float d, float e, float m) { m *= 4.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); float m4 = clamp(m - 3.0, 0.0, 1.0); float ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); float th = mix(ft, mix(c, d, m3), step(2.0, m)); return mix(th, mix(d, e, m4), step(3.0, m)); }
vec3 _mix5(vec3 a, vec3 b, vec3 c, vec3 d, vec3 e, float m) { m *= 4.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); float m4 = clamp(m - 3.0, 0.0, 1.0); vec3 ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); vec3 th = mix(ft, mix(c, d, m3), step(2.0, m)); return mix(th, mix(d, e, m4), step(3.0, m)); }
vec4 _mix5(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, float m) { m *= 4.0; float m1 = clamp(m, 0.0, 1.0); float m2 = clamp(m - 1.0, 0.0, 1.0); float m3 = clamp(m - 2.0, 0.0, 1.0); float m4 = clamp(m - 3.0, 0.0, 1.0); vec4 ft = mix(mix(a, b, m1), mix(b, c, m2), step(1.0, m)); vec4 th = mix(ft, mix(c, d, m3), step(2.0, m)); return mix(th, mix(d, e, m4), step(3.0, m)); }
`;

/* --------------------------------------------------------- hashes + noise */
const LIB_NOISE = `
float _rand(float seed) { return fract(sin(seed) * 43758.5453123); }
float _rand(vec2 seed) { return fract(sin(dot(seed, vec2(12.9898, 4.1414))) * 43758.5453); }

float _hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float _hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float _hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 _hash21(float p) { vec3 p3 = fract(vec3(p) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec2 _hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec2 _hash23(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 _hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3 _hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3 _hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec4 _hash41(float p) { vec4 p4 = fract(vec4(p) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
vec4 _hash42(vec2 p) { vec4 p4 = fract(vec4(p.xyxy) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
vec4 _hash43(vec3 p) { vec4 p4 = fract(vec4(p.xyzx) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
vec4 _hash44(vec4 p4) { p4 = fract(p4 * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }

float _noise(float seed) { float f = floor(seed); float r = fract(seed); return mix(_rand(f), _rand(f + 1.0), r); }
float _noise(vec2 seed) {
  const vec2 d = vec2(0.0, 1.0);
  vec2 f = floor(seed);
  vec2 r = smoothstep(vec2(0.0), vec2(1.0), fract(seed));
  return mix(mix(_rand(f), _rand(f + d.yx), r.x), mix(_rand(f + d.xy), _rand(f + d.yy), r.x), r.y);
}
float _mod289(float x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _perm(vec4 x) { return _mod289(((x * 34.0) + 1.0) * x); }
float _noise(vec3 p) {
  vec3 a = floor(p); vec3 d = p - a; d = d * d * (3.0 - 2.0 * d);
  vec4 b = a.xxyy + vec4(0.0, 1.0, 0.0, 1.0);
  vec4 k1 = _perm(b.xyxy);
  vec4 k2 = _perm(k1.xyxy + b.zzww);
  vec4 c = k2 + a.zzzz;
  vec4 k3 = _perm(c);
  vec4 k4 = _perm(c + 1.0);
  vec4 o1 = fract(k3 * (1.0 / 41.0));
  vec4 o2 = fract(k4 * (1.0 / 41.0));
  vec4 o3 = o2 * d.z + o1 * (1.0 - d.z);
  vec2 o4 = o3.yw * d.x + o3.xz * (1.0 - d.x);
  return o4.y * d.y + o4.x * (1.0 - d.y);
}
float _fbm(float position, float octaves) {
  float v = 0.0; float a = 0.5; float shift = 100.0;
  for (int i = 0; i < 32; ++i) { if (float(i) >= octaves) break;
    v += a * _noise(position); position = position * 2.0 + shift; a *= 0.5; }
  return v;
}
float _fbm(vec2 position, float octaves) {
  float v = 0.0; float a = 0.5; vec2 shift = vec2(100.0);
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int i = 0; i < 32; ++i) { if (float(i) >= octaves) break;
    v += a * _noise(position); position = rot * position * 2.0 + shift; a *= 0.5; }
  return v;
}
float _fbm(vec3 position, float octaves) {
  float v = 0.0; float a = 0.5; vec3 shift = vec3(100.0);
  for (int i = 0; i < 32; ++i) { if (float(i) >= octaves) break;
    v += a * _noise(position); position = position * 2.0 + shift; a *= 0.5; }
  return v;
}
float _fbm(float position) { return _fbm(position, 5.0); }
float _fbm(vec2 position) { return _fbm(position, 5.0); }
float _fbm(vec3 position) { return _fbm(position, 5.0); }
`;

/* --------------------------------------------------------------- color ops */
const LIB_COLOR = `
vec3 _hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 _rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y); float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec4 _brightness(vec4 color, float b) { return color * b; }
vec3 _brightness(vec3 color, float b) { return color * b; }
vec3 _gamma(vec3 color, float g) { color.rgb = pow(color.rgb, 1.0 / vec3(g)); return color; }
vec4 _gamma(vec4 color, float g) { color.rgb = _gamma(color.rgb, g); return color; }
vec3 _contrast(vec3 color, float c) { color = (color - 0.5) * c + 0.5; return color; }
vec4 _contrast(vec4 color, float c) { color.rgb = _contrast(color.rgb, c); return color; }
vec3 _saturation(vec3 color, float s) { vec3 hsv = _rgb2hsv(color); hsv.y *= s; return _hsv2rgb(hsv); }
vec4 _saturation(vec4 color, float s) { color.rgb = _saturation(color.rgb, s); return color; }
vec3 _invert(vec3 color, float inv) { return mix(color, 1.0 - color, inv); }
vec4 _invert(vec4 color, float inv) { return mix(color, 1.0 - color, inv); }
float _luminance(vec3 color) { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }
float _luminance(vec4 color) { return _luminance(color.rgb); }
vec3 _grayscale(vec3 rgb, float intensity) { float l = _luminance(rgb); return mix(rgb, vec3(l), clamp(intensity, 0.0, 1.0)); }
vec4 _grayscale(vec4 rgba, float intensity) { rgba.rgb = _grayscale(rgba.rgb, intensity); return rgba; }
vec3 _grayscale(vec3 rgb) { return _grayscale(rgb, 1.0); }
vec4 _grayscale(vec4 rgba) { return _grayscale(rgba, 1.0); }
vec3 _dichrome(vec3 color, vec3 lowColor, vec3 highColor) {
  float l = _luminance(color); l = sqrt(l); l *= 3.0;
  vec3 black = vec3(0.0); vec3 white = vec3(1.0);
  if (l <= 1.0) { color = mix(black, lowColor, clamp(l, 0.0, 1.0)); }
  else if (l <= 2.0) { color = mix(lowColor, highColor, clamp(l - 1.0, 0.0, 1.0)); }
  else if (l <= 3.0) { color = mix(highColor, white, clamp(l - 2.0, 0.0, 1.0)); }
  return color;
}
vec4 _dichrome(vec4 color, vec3 lowColor, vec3 highColor) { color.rgb = _dichrome(color.rgb, lowColor, highColor); return color; }
vec3 _normalizeRGB(float r, float g, float b) {
  r = clamp(r, 0.0, 255.0); g = clamp(g, 0.0, 255.0); b = clamp(b, 0.0, 255.0);
  return vec3(r, g, b) / 255.0;
}
vec3 _hueRotate(vec3 color, float rot) {
  float hue = radians(rot);
  const vec3 k = vec3(0.57735, 0.57735, 0.57735);
  float cosAngle = cos(hue);
  return vec3(color * cosAngle + cross(k, color) * sin(hue) + k * dot(k, color) * (1.0 - cosAngle));
}
vec4 _hueRotate(vec4 color, float rot) { color.rgb = _hueRotate(color.rgb, rot); return color; }
vec3 _palette(in float t, in vec3 a, in vec3 b, in vec3 c, in vec3 d) { return a + b * cos(6.28318 * (c * t + d)); }
vec4 _hueSaturation(vec4 color, float hue, float saturation) {
  color.rgb = _rgb2hsv(clamp(color.rgb, 0.0, 1.0));
  color.r = color.r + hue;
  color.g = clamp(color.g + saturation, 0.0, 1.0);
  color.rgb = _hsv2rgb(color.rgb);
  return color;
}
`;

/* ---------------------------------------------- images, media, ISF compat
   The `_loadImage`/`_textureImage` family does aspect-ratio-correct sampling
   against RENDERSIZE, so an image keeps its proportions whatever the canvas is.
   The media half is kept structurally intact but always resolves to the
   runtime's 1x1 transparent stand-in: this shim has no video/webcam input, and
   syn_MediaType is pinned to 0, so `_isMediaActive()` is false and scenes take
   their no-media branch exactly as they would in the app with nothing loaded. */
const LIB_IMAGE = `
vec4 IMG_NORM_PIXEL(sampler2D tex, vec2 uv) { return texture(tex, uv); }
vec4 IMG_PIXEL(sampler2D tex, ivec2 uv) { return texelFetch(tex, uv, 0); }
vec4 IMG_THIS_PIXEL(sampler2D tex) { return texelFetch(tex, ivec2(_xy), 0); }
vec4 IMG_THIS_NORM_PIXEL(sampler2D tex) { return texture(tex, _uv); }
vec4 IMG_PIXEL(sampler2D tex, vec2 uv) { return texelFetch(tex, ivec2(uv), 0); }
vec2 IMG_SIZE(sampler2D tex) { return vec2(textureSize(tex, 0)); }

bool _isMediaActive() { return syn_MediaType > 0.5; }
vec2 _mediaSize() { return vec2(textureSize(syn_Media, 0)); }
vec2 _flipMediaCoords(vec2 pos) {
  if (syn_MediaType > 1.5 && syn_MediaType < 2.5) { pos.y = 1.0 - pos.y; }
  else if (syn_MediaType > 2.5 && syn_MediaType < 3.5) { pos.x = 1.0 - pos.x; pos.y = 1.0 - pos.y; }
  if (_Hor_Flip > 0.5) pos.x = 1.0 - pos.x;
  if (_Vert_Flip > 0.5) pos.y = 1.0 - pos.y;
  _uv2uvc(pos); pos *= _Media_Scale; _uvc2uv(pos);
  return pos;
}
vec2 _invertYAxisVideo(vec2 pos) { return _flipMediaCoords(pos); }
float _ratioFix(float wr, float hr) { return _Fit_or_Fill > 0.5 ? max(wr, hr) : min(wr, hr); }
vec2 _correctImageCoords(vec2 imageSize, vec2 uv) {
  float wr = RENDERSIZE.x / imageSize.x;
  float hr = RENDERSIZE.y / imageSize.y;
  float ratio = _ratioFix(wr, hr);
  vec2 c = uv;
  c.y *= hr / ratio; c.x *= wr / ratio;
  c.x += -wr / ratio / 2.0 + 0.5;
  c.y += -hr / ratio / 2.0 + 0.5;
  return c;
}
vec2 _correctImageCoords(vec2 imageSize) { return _correctImageCoords(imageSize, _uv); }
vec2 _correctMediaCoords(vec2 uv) { return _correctImageCoords(_mediaSize(), uv); }
vec2 _correctMediaCoords() { return _correctImageCoords(_mediaSize(), _uv); }
vec2 _correctUserImageCoords(vec2 uv) { return _correctImageCoords(vec2(textureSize(syn_UserImage, 0)), uv); }

vec4 _imageToMask(vec4 colIn) {
  float threshold = _Media_Contrast * 0.5;
  float l = _luminance(colIn);
  return vec4(step(threshold, l));
}
vec4 _loadImage(sampler2D img, vec2 offset, bool isRawMedia) {
  vec2 uv = _correctImageCoords(vec2(textureSize(img, 0)));
  if (isRawMedia) uv = _flipMediaCoords(uv);
  if (_inRange(uv, 0.0, 1.0) < 0.5) return vec4(0.0);
  return texture(img, uv + offset);
}
vec4 _loadImage(sampler2D img) { return _loadImage(img, vec2(0.0), false); }
vec4 _loadImage(sampler2D img, vec2 offset) { return _loadImage(img, offset, false); }
vec4 _textureImage(sampler2D img, vec2 uv, bool isRawMedia) {
  uv = _correctImageCoords(vec2(textureSize(img, 0)), uv);
  if (isRawMedia) uv = _flipMediaCoords(uv);
  return texture(img, uv);
}
vec4 _textureImage(sampler2D img, vec2 uv) { return _textureImage(img, uv, false); }
vec4 _loadImage(sampler2D img, vec2 offset, bool isRawMedia, float lod) {
  vec2 uv = _correctImageCoords(vec2(textureSize(img, int(lod))));
  if (isRawMedia) uv = _flipMediaCoords(uv);
  if (_inRange(uv, 0.0, 1.0) < 0.5) return vec4(0.0);
  return textureLod(img, uv + offset, lod);
}
vec4 _textureImage(sampler2D img, vec2 uv, bool isRawMedia, float lod) {
  uv = _correctImageCoords(vec2(textureSize(img, int(lod))), uv);
  if (isRawMedia) uv = _flipMediaCoords(uv);
  return textureLod(img, uv, lod);
}
vec4 _loadImageAsMask(sampler2D img, vec2 offset, bool isRawMedia) { return _imageToMask(_loadImage(img, offset, isRawMedia)); }
vec4 _loadImageAsMask(sampler2D img) { return _loadImageAsMask(img, vec2(0.0), false); }
vec4 _loadImageAsMask(sampler2D img, vec2 offset) { return _loadImageAsMask(img, offset, false); }
vec4 _loadImageAsMask(sampler2D img, vec2 offset, bool isRawMedia, float lod) { return _imageToMask(_loadImage(img, offset, isRawMedia, lod)); }
vec4 _textureImageAsMask(sampler2D img, vec2 uv, bool isRawMedia) { return _imageToMask(_textureImage(img, uv, isRawMedia)); }
vec4 _textureImageAsMask(sampler2D img, vec2 uv) { return _textureImageAsMask(img, uv, false); }
vec4 _textureImageAsMask(sampler2D img, vec2 uv, bool isRawMedia, float lod) { return _imageToMask(_textureImage(img, uv, isRawMedia, lod)); }
`;

/* ------------------------------------- meta controls + the _apply* family */
const LIB_META = `
vec4 _applyMaster(vec4 c) { c = clamp(c, 0.0, 1.0); return _brightness(c, _Master); }
vec4 _applyBrightness(vec4 c) { return _brightness(c, _Brightness); }
vec4 _applyGamma(vec4 c) { float g = _Gamma; if (g > 1.0) g = 1.0 + (g - 1.0) * 2.0; return _gamma(c, g); }
vec4 _applyContrast(vec4 c) { float k = _Contrast; if (k > 1.0) k *= k; return _contrast(c, k); }
vec4 _applyHueSaturation(vec4 c) { return _hueSaturation(c, _Hue, _Saturation); }
vec4 _applyInvert(vec4 c) { return _invert(c, _Invert); }
vec4 _applyInvertMedia(vec4 c) { return _invert(c, _Invert_Media); }
vec4 _applyMediaContrast(vec4 c) { float k = _Media_Contrast; if (k > 1.0) k *= k; return _contrast(c, k); }
vec4 _applyMediaGamma(vec4 c) { float g = _Media_Gamma; if (g > 1.0) g *= g; return _gamma(c, g); }
vec4 _applyMediaHueSaturation(vec4 c) { return _hueSaturation(c, _Media_Hue, _Media_Saturation); }
vec4 _applyColorCorrection(vec4 c) { return _applyMaster(_applyBrightness(_applyGamma(_applyContrast(_applyHueSaturation(_applyInvert(c)))))); }
vec4 _applyAllLuminanceCorrections(vec4 c) { return _applyColorCorrection(c); }
vec4 _hueSaturationContrast(vec4 c, float hue, float sat, float con) { c = _hueSaturation(c, hue, sat); return _applyContrast(c); }
vec4 _applyHueSaturationContrast(vec4 c) { return _hueSaturationContrast(c, _Hue, _Saturation, _Contrast); }
vec4 _applyDichrome(vec4 c) { if (_Limit_Colors < 0.5) return c; return _dichrome(c, _Low_Color, _High_Color); }
vec4 _applyAlpha(vec4 c) { if (_Alpha_Channel < 0.5) c.a = 1.0; return c; }
vec2 _applyVerticalMirroring(vec2 p) { if (_Vert_Mirror > 0.5 && p.x > 0.5) p.x = 1.0 - p.x; return p; }
vec2 _applyHorizontalMirroring(vec2 p) { if (_Hor_Mirror > 0.5 && p.y < 0.5) p.y = 1.0 - p.y; return p; }
float _zoomOrFit(float wr, float hr) { return syn_Prefs_ZoomOrFit > 0.5 ? max(wr, hr) : min(wr, hr); }
vec4 _invertImage(vec4 c) { return _applyInvertMedia(c); }

vec4 _loadMedia() { return _loadImage(syn_Media, vec2(0.0), false); }
vec4 _loadMedia(vec2 offset) { return _loadImage(syn_Media, offset, false); }
vec4 _loadMedia(float lod) { return _loadImage(syn_Media, vec2(0.0), false, lod); }
vec4 _loadMedia(vec2 offset, float lod) { return _loadImage(syn_Media, offset, false, lod); }
vec4 _textureMedia(vec2 uv) { return _textureImage(syn_Media, uv, false); }
vec4 _textureMedia(vec2 uv, float lod) { return _textureImage(syn_Media, uv, false, lod); }
vec4 _loadMediaAsMask() { return _applyInvertMedia(_loadImageAsMask(syn_UserImage, vec2(0.0), true)); }
vec4 _loadMediaAsMask(vec2 offset) { return _applyInvertMedia(_loadImageAsMask(syn_UserImage, offset, true)); }
vec4 _loadMediaAsMask(float lod) { return _applyInvertMedia(_loadImageAsMask(syn_UserImage, vec2(0.0), true, lod)); }
vec4 _loadMediaAsMask(vec2 offset, float lod) { return _applyInvertMedia(_loadImageAsMask(syn_UserImage, offset, true, lod)); }
vec4 _textureMediaAsMask(vec2 uv) { return _applyInvertMedia(_textureImageAsMask(syn_UserImage, uv, true)); }
vec4 _textureMediaAsMask(vec2 uv, float lod) { return _applyInvertMedia(_textureImageAsMask(syn_UserImage, uv, true, lod)); }
vec4 _loadUserImage() { return _loadImage(syn_Media, vec2(0.0), false); }
vec4 _loadUserImage(vec2 offset) { return _loadImage(syn_Media, offset, false); }
vec4 _textureUserImage(vec2 uv) { return _textureImage(syn_Media, uv, false); }
vec4 _loadUserImageAsMask() { return _applyInvertMedia(_loadImageAsMask(syn_UserImage, vec2(0.0), true)); }
vec4 _loadUserImageAsMask(vec2 offset) { return _applyInvertMedia(_loadImageAsMask(syn_UserImage, offset, true)); }
vec4 _textureUserImageAsMask(vec2 uv) { return _applyInvertMedia(_textureImageAsMask(syn_UserImage, uv, true)); }
`;

/* ------------------------------------------- 1-row data-texture accessors
   syn_Spectrum / syn_LevelTrail are sampler1D on the desktop. ES 3.00 has no
   sampler1D, so they are 1-row sampler2Ds here and syn-runtime.js rewrites
   `texture(syn_Spectrum, x)` / `texelFetch(syn_Spectrum, i, 0)` call sites to
   the 2D spellings. These named helpers are the tidy way to say the same
   thing from scene code that has already been ported by hand. */
const LIB_DATATEX = `
vec4 _spectrum(float x) { return texture(syn_Spectrum, vec2(clamp(x, 0.0, 1.0), 0.5)); }
vec4 _levelTrail(float x) { return texture(syn_LevelTrail, vec2(clamp(x, 0.0, 1.0), 0.5)); }
`;

/* ------------------------------------------------- syn_pass_* pass filters
   Synesthesia exposes a handful of whole-pass image operators that take a
   buffer sampler and read it at the current fragment. Only the Sobel one is
   actually called by a shipped scene (mana); the rest appear in scenes'
   documentation comments. It is written against RENDERSIZE, which is the
   destination pass's size — the same convention the desktop uses. */
const LIB_PASSFX = `
float syn_pass_edgeDetectSobel(sampler2D tex) {
  vec2 px = 1.0 / RENDERSIZE;
  vec2 uv = gl_FragCoord.xy / RENDERSIZE;
  float gx = 0.0, gy = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 c = texture(tex, uv + vec2(float(i), float(j)) * px).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      float wx = (i == 0) ? 0.0 : (i < 0 ? -1.0 : 1.0);
      float wy = (j == 0) ? 0.0 : (j < 0 ? -1.0 : 1.0);
      gx += l * wx * ((j == 0) ? 2.0 : 1.0);
      gy += l * wy * ((i == 0) ? 2.0 : 1.0);
    }
  }
  return sqrt(gx * gx + gy * gy);
}
`;

export const GLSL_LIB = LIB_MATH + LIB_NOISE + LIB_COLOR + LIB_IMAGE + LIB_META
  + LIB_DATATEX + LIB_PASSFX;

/* ------------------------------------------------------------- uniforms
   Every name Synesthesia injects, so a scene referencing any of them links.
   Grouped the way the docs group them; syn-runtime.js appends the per-scene
   control / image / pass / script uniforms after this block. */
export const SYN_FLOAT_UNIFORMS = [
  // level
  'syn_Level', 'syn_RawLevel',
  'syn_BassLevel', 'syn_MidLevel', 'syn_MidHighLevel', 'syn_HighLevel',
  // transient hits
  'syn_Hits', 'syn_BassHits', 'syn_MidHits', 'syn_MidHighHits', 'syn_HighHits',
  // energy-driven clocks
  'syn_Time', 'syn_BassTime', 'syn_MidTime', 'syn_MidHighTime', 'syn_HighTime',
  'syn_CurvedTime',
  // slow presence
  'syn_Presence', 'syn_BassPresence', 'syn_MidPresence', 'syn_MidHighPresence',
  'syn_HighPresence',
  // beat
  'syn_OnBeat', 'syn_ToggleOnBeat', 'syn_RandomOnBeat', 'syn_BeatTime',
  // tempo
  'syn_BPM', 'syn_BPMConfidence', 'syn_BPMTwitcher',
  'syn_BPMSin', 'syn_BPMSin2', 'syn_BPMSin4',
  'syn_BPMTri', 'syn_BPMTri2', 'syn_BPMTri4',
  // long-form
  'syn_FadeInOut', 'syn_Intensity',
  // older spellings still referenced by a couple of shipped scenes
  'syn_InputLevel', 'syn_BassExpoCurve',
  // media
  'syn_MediaType', 'syn_Prefs_ZoomOrFit',
];

// meta (global colour/geometry) controls; neutral constants in this shim
export const META_FLOAT_UNIFORMS = [
  '_Master', '_Brightness', '_Gamma', '_Contrast', '_Hue', '_Saturation',
  '_Invert', '_Alpha_Channel', '_Limit_Colors', '_Vert_Mirror', '_Hor_Mirror',
  '_Vert_Flip', '_Hor_Flip', '_Fit_or_Fill', '_Invert_Media',
  '_Media_Contrast', '_Media_Gamma', '_Media_Hue', '_Media_Saturation',
  '_Media_Scale',
];

export const META_VEC3_UNIFORMS = ['_Low_Color', '_High_Color'];

export const META_DEFAULTS = {
  _Master: 1, _Brightness: 1, _Gamma: 1, _Contrast: 1, _Hue: 0, _Saturation: 0,
  _Invert: 0, _Alpha_Channel: 0, _Limit_Colors: 0, _Vert_Mirror: 0,
  _Hor_Mirror: 0, _Vert_Flip: 0, _Hor_Flip: 0, _Fit_or_Fill: 0,
  _Invert_Media: 0, _Media_Contrast: 1, _Media_Gamma: 1, _Media_Hue: 0,
  _Media_Saturation: 0, _Media_Scale: 1,
};

export const SYN_SAMPLER_UNIFORMS = [
  'syn_Spectrum', 'syn_LevelTrail', 'syn_Media', 'syn_UserImage', 'syn_FinalPass',
];
