/* SynScene — run a Synesthesia .synScene folder inside vizier
   ============================================================================
   A .synScene is a folder of `scene.json` (controls, render passes, bundled
   images), `main.glsl` (one fragment shader defining `vec4 renderMain()`), and
   an optional `script.js` (per-frame JS that pushes extra uniforms). Synesthesia
   runs that against desktop OpenGL with a ~20 KB GLSL preamble and its own
   audio analysis. This class runs it against WebGL2 with vizier's.

   Usage from a demo wrapper — the whole point is that it satisfies the gallery's
   demo contract, so a port is about ten lines:

       import { SynScene } from './syn/syn-runtime.js';
       export default class extends SynScene {
         constructor(canvas) { super(canvas, { dir: './demos/syn/scenes/nova.synScene' }); }
       }

   Structure
     load()        fetch scene.json / main.glsl / script.js / images
     _buildSource  desktop GLSL 330 -> GLSL ES 3.00 (see transformSource)
     _compile      one program per pass, PASSINDEX baked in as a #define
     render()      script -> uniforms -> pass chain -> blit to canvas

   The pass chain follows Shadertoy/Synesthesia buffer semantics exactly: every
   PASSES target is persistent and double-buffered, so within a frame a pass
   reading an EARLIER pass's target sees this frame's value, while a pass reading
   its OWN target sees last frame's. The final pass renders to an offscreen
   target (not straight to the canvas) so that it is available next frame as
   `syn_FinalPass`, then gets blitted.

   Everything fails soft. No context, a shader that will not compile, a missing
   file, a script that throws — each paints its message on the canvas and keeps
   the gallery alive, per the demo contract.
   ========================================================================== */

'use strict';

import {
  GLSL_GLOBALS, GLSL_GLOBAL_INIT, GLSL_LIB,
  SYN_FLOAT_UNIFORMS, SYN_SAMPLER_UNIFORMS,
  META_FLOAT_UNIFORMS, META_VEC3_UNIFORMS, META_DEFAULTS,
} from './syn-prelude.js';
import { SynAudio, SPECTRUM_BINS, TRAIL_BINS } from './syn-audio.js';
import { SYN_GRADE } from './syn-settings.js';

/* ============================================================ GLSL transform
   The three differences between desktop GLSL 330 (what scenes are written in)
   and GLSL ES 3.00 (what WebGL2 gives us) that actually bite, all confirmed by
   compiling probes against ANGLE:

     1. ES 3.00 rejects NON-CONSTANT global initializers. Scenes rely on them —
        `vec4 iMouse = vec4(720, 720, 0, 0);` is fine, but `float DISP = (... *
        media_refract * length(_uvc)) * 0.015;` (dynamical_flame) reads a uniform
        AND a per-fragment global. hoistGlobalInits() splits every such
        declaration into a bare declaration plus an assignment collected into
        `_initGlobals()`, which main() calls before renderMain(). Declaration
        order is preserved, which matters: the desktop evaluates these in order
        at the top of main and later ones can read earlier ones.
     2. `PASSINDEX` is an int, but roughly half the scene corpus compares it
        against float literals (`PASSINDEX == 0.0`). ES 3.00 has no implicit
        int->float, so both spellings are normalized to an int comparison and
        PASSINDEX is baked as a #define — which also lets the compiler drop the
        dead branches of every other pass.
     3. ES 3.00 has no `sampler1D`, which is what syn_Spectrum and
        syn_LevelTrail are on the desktop. They become 1-row sampler2Ds and
        their call sites are rewritten.

   Then the int/float looseness, which is what actually decides whether a scene
   from the shipped corpus compiles. Desktop GLSL promotes int to float
   implicitly and the scenes rely on that constantly; ES 3.00 does not, and no
   single rule covers it. Four passes divide the work, in this order:

     4. promoteIntLiterals   bare int literals -> float, except where an int is
                             structurally required (subscripts, int-taking calls,
                             int declarations, for-headers, % << >> & | ^)
     5. demoteIntVars        a scalar `int x = ...` whose every use is float-safe
                             becomes `float x = float(...)` — this is what fixes
                             `value /= iters` and `0.04 * i`, which no amount of
                             literal rewriting can reach
     6. repairIntComparisons the ones step 4 over-promoted: `id == 1.0` back to
                             `id == 1` for names still typed int
     7. repairIntFloatMixing an int variable directly against a float literal or
                             a float-only builtin, cast where it stands
     8. repairForHeaders     `for (int i = 0; i <= someFloatSlider; i++)`, the
                             single most common failure in the corpus

   Everything they cannot type with certainty is left as written, so it fails
   with a compile error naming its source line rather than rendering something
   quietly wrong. A scene that trips on one of those gets a targeted `patches`
   entry in its wrapper, which keeps the copied scene folder a pristine copy of
   the original. demos/tuning/syn_probe.sh is how the whole roster is checked
   after any change here.
   ========================================================================== */

/* Replace comment bodies with spaces, preserving newlines so compiler error
   line numbers still point at the original source. Also keeps the regex passes
   below from matching inside commented-out code. */
export function blankComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/* `texture(syn_Spectrum, x)` -> `texture(syn_Spectrum, vec2(x, 0.5))` and
   `texelFetch(syn_Spectrum, i, 0)` -> `texelFetch(syn_Spectrum, ivec2(i, 0), 0)`.
   Needs balanced-paren argument splitting because the coordinate is often an
   expression with its own calls. */
export function rewriteDataTextures(src, names) {
  for (const fn of ['texture', 'texelFetch']) {
    let idx = 0;
    for (;;) {
      const at = src.indexOf(fn + '(', idx);
      if (at < 0) break;
      // must be a whole identifier, not the tail of `myTexture(`
      const before = at > 0 ? src[at - 1] : ' ';
      if (/[A-Za-z0-9_]/.test(before)) { idx = at + 1; continue; }
      const open = at + fn.length;
      const close = matchParen(src, open);
      if (close < 0) { idx = at + 1; continue; }
      const args = splitArgs(src.slice(open + 1, close));
      if (args.length < 2 || !names.includes(args[0].trim())) { idx = at + 1; continue; }
      const coord = args[1].trim();
      let rebuilt;
      if (fn === 'texture') {
        rebuilt = `texture(${args[0].trim()}, vec2(${coord}, 0.5))`;
      } else {
        const rest = args.slice(2).join(',');
        rebuilt = `texelFetch(${args[0].trim()}, ivec2(${coord}, 0)${rest ? ',' + rest : ', 0'})`;
      }
      src = src.slice(0, at) + rebuilt + src.slice(close + 1);
      idx = at + rebuilt.length;
    }
  }
  return src;
}

function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitArgs(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// `\b` matters: without it `in` matches the front of `int iFrame = ...` and the
// declaration silently escapes hoisting
const DECL_SKIP = /^\s*(?:(?:const|uniform|attribute|varying|in|out|inout|layout|precision|struct)\b|#)/;

/* Split top-level `TYPE name = expr;` declarations into `TYPE name;` plus an
   assignment, returning { source, init }. Only touches statements at brace
   depth 0 that contain a top-level `=` and no `(` before it (which would make
   them function declarations). */
export function hoistGlobalInits(src) {
  const init = [];
  let out = '';
  let depth = 0, paren = 0, stmt = 0, i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    if (c === '#' && (i === 0 || src[i - 1] === '\n')) {
      // preprocessor directive: copy verbatim, it is not a statement
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end + 1;
      out += src.slice(stmt, stop);
      i = stmt = stop;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '{') { depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0) { out += src.slice(stmt, i + 1); i++; stmt = i; continue; }
    } else if (c === ';' && depth === 0 && paren === 0) {
      const text = src.slice(stmt, i);          // statement without the `;`
      out += transformDecl(text, init);
      out += ';';
      i++; stmt = i;
      continue;
    }
    i++;
  }
  out += src.slice(stmt);
  return { source: out, init: init.join('\n') };
}

function transformDecl(text, init) {
  if (DECL_SKIP.test(text)) return text;
  const eq = topLevelEq(text);
  if (eq < 0) return text;                       // no initializer, leave alone
  // a `(` before the `=` means this is a function definition/prototype
  if (text.slice(0, eq).includes('(')) return text;

  // TYPE then the declarator list
  const m = /^(\s*)((?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([\s\S]*)$/.exec(text);
  if (!m) return text;
  const [, lead, prec, type, rest] = m;
  const parts = splitArgs(rest);
  const decls = [];
  let touched = false;
  for (const part of parts) {
    const e = topLevelEq(part);
    if (e < 0) { decls.push(part.trim()); continue; }
    const name = part.slice(0, e).trim();
    const expr = part.slice(e + 1).trim();
    if (!/^[A-Za-z_]\w*(\s*\[[^\]]*\])?$/.test(name)) { decls.push(part.trim()); continue; }
    decls.push(name);
    // strip any array suffix from the assignment target: `a[3] = x` -> `a = x`
    init.push(`  ${name.replace(/\s*\[[^\]]*\]\s*$/, '')} = ${expr};`);
    touched = true;
  }
  if (!touched) return text;
  return `${lead}${prec || ''}${type} ${decls.join(', ')}`;
}

function topLevelEq(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '=' && depth === 0) {
      // skip ==, <=, >=, !=
      if (s[i + 1] === '=') { i++; continue; }
      if (i > 0 && '=<>!+-*/'.includes(s[i - 1])) continue;
      return i;
    }
  }
  return -1;
}

/* ------------------------------------------------- integer literal promotion
   Desktop GLSL promotes int to float implicitly; GLSL ES 3.00 does not, and
   scene authors write `mix(2, 20, a4)`, `uv -= 1/zoom`, `t > 5`, `bassTime*2*PI`
   constantly. Rather than hand-patch every one, promote bare integer literals to
   float literals — but only where an int is not actually required, since
   `for (int i = 0; ...)` and `arr[3]` and `texelFetch(t, c, 0)` must stay int.

   Protected contexts, all of them structural and cheap to track:
     - preprocessor lines (a #define body has no type context to speak of)
     - inside [] subscripts
     - direct arguments of int-typed constructors and int-argument builtins
       (int, uint, ivecN, uvecN, textureSize, texelFetch) and of any function
       the scene defines with an int parameter
     - any statement whose base type is int/uint/bool (so `int n = 4;` survives)
     - a whole `for (...)` header, which is int-driven in practice
     - operands of the int-only operators % << >> & | ^ ~
     - `case 3:` labels
   Anything the tracker cannot classify stays as written and shows up as a
   compile error with its source line, which is the right failure mode: visible
   and specific, rather than silently wrong.

   Runs BEFORE the PASSINDEX normalization on purpose — that pass then forces
   `PASSINDEX == 0.0` back to an int comparison, undoing this one where it must. */
const INT_TYPE = /^(?:int|uint|ivec[234]|uvec[234]|bool|bvec[234])$/;
// qualifiers are transparent: `const int iter = 12;` must still read as an int
// declaration, or the 12 gets promoted and the shader stops compiling
const QUALIFIER = /^(?:const|uniform|attribute|varying|in|out|inout|flat|smooth|noperspective|centroid|highp|mediump|lowp|precise)$/;
const BUILTIN_INT_CALLS = new Set(['int', 'uint', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'textureSize', 'texelFetch', 'texelFetchOffset']);

/* Names of functions the scene itself defines with an int/uint/bool parameter.
   nova declares `vec4 BlurA(vec2 uv, int level)` and calls it as `BlurA(uv, 0)`
   — promote that 0 and the call no longer resolves, so these have to be found
   and their direct arguments left alone. */
export function findIntParamFunctions(src) {
  const names = new Set();
  const re = /\b[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    if (/\b(?:int|uint|ivec[234]|uvec[234]|bool|bvec[234])\b/.test(m[2])) names.add(m[1]);
  }
  return names;
}

export function promoteIntLiterals(src) {
  const userIntCalls = findIntParamFunctions(src);
  let out = '';
  let i = 0;
  const n = src.length;
  let bracket = 0;          // [] nesting
  let paren = 0;
  let forDepth = -1;        // paren depth of an open for(...) header
  let stmtIsInt = false;    // current statement declares an int/uint/bool
  let caseLabel = false;
  let atStmtStart = true;
  let lastWord = '';
  /* One entry per open paren, flagging whether its DIRECT arguments must stay
     int. Direct-only matters: in `GradientA(uv, d, vec4(0,0,0.15,0), 1)` the
     trailing 1 is an int level, while the literals inside the vec4 are floats. */
  const callStack = [];

  /* Protection applies only to a literal that IS the whole argument. The
     earlier "any literal directly inside an int call" rule was too wide:
     `texelFetch(syn_Spectrum, ivec2(int(x*1024), 0), 0)` (audio_indicators)
     needs the 1024 promoted — it is part of a float sub-expression that the
     int() constructor then truncates, not an int being passed. */
  const protectedArgs = (end) => {
    if (!callStack.length || !callStack[callStack.length - 1]) return false;
    let k = lastNonSpaceIdx(out, out.length - 1);
    if (k >= 0 && (out[k] === '-' || out[k] === '+')) k = lastNonSpaceIdx(out, k - 1);
    const prev = k >= 0 ? out[k] : '';
    if (prev !== '(' && prev !== ',') return false;
    const after = src.slice(end).replace(/^\s+/, '')[0];
    return after === ',' || after === ')';
  };

  while (i < n) {
    const c = src[i];

    if (c === '#' && (i === 0 || src[i - 1] === '\n')) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    if (/[0-9]/.test(c)) {
      const prev = i > 0 ? src[i - 1] : ' ';
      if (/[A-Za-z0-9_.]/.test(prev)) { out += c; i++; continue; }  // mid-token
      // the digits after a signed exponent are part of the float that opened it:
      // `1e-3` reaches the `3` with prev === '-', which otherwise reads as a
      // fresh literal and produces the syntax error `1e-3.0`
      if ((prev === '-' || prev === '+') && /[eE]/.test(src[i - 2] || '')
          && /[0-9.]/.test(src[i - 3] || '')) { out += c; i++; continue; }
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      const next = j < n ? src[j] : '';
      const isInt = !/[.eExXuUfF]/.test(next);
      // an int-only operator on either side means the literal must stay an int
      const prevOp = /[%&|^~]/.test(lastNonSpace(out))
        || /(<<|>>)$/.test(out.replace(/\s+$/, ''));
      const nextOp = /^\s*(?:%|<<|>>|&(?!&)|\|(?!\|)|\^)/.test(src.slice(j));
      const keepInt = bracket > 0 || protectedArgs(j) || stmtIsInt || caseLabel
        || (forDepth >= 0 && paren > forDepth) || prevOp || nextOp;
      out += src.slice(i, j) + (isInt && !keepInt ? '.0' : '');
      i = j;
      atStmtStart = false;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (atStmtStart && INT_TYPE.test(word)) stmtIsInt = true;
      if (word === 'case') caseLabel = true;
      /* A for-header is int-driven only when it actually declares an int
         counter. `for (float i = 0; i < 60; ++i)` (beamers, inkshot) is a float
         loop written with int literals, and blanket-protecting the header there
         leaves `float i = 0` — which ES 3.00 rejects. */
      if (word === 'for' && /^\s*\(\s*(?:const\s+)?(?:int|uint)\b/.test(src.slice(j))) {
        forDepth = paren;     // header opens at the next '('
      }
      // qualifiers do not end the "start of statement" run
      if (!QUALIFIER.test(word)) atStmtStart = false;
      lastWord = word;
      out += word;
      i = j;
      continue;
    }

    if (c === '(') {
      callStack.push(BUILTIN_INT_CALLS.has(lastWord) || userIntCalls.has(lastWord));
      paren++;
      lastWord = '';
    } else if (c === ')') {
      callStack.pop();
      paren--;
      if (forDepth >= 0 && paren === forDepth) {
        /* End of a for-header. `stmtIsInt` was set by its `int i` declaration
           and the header's own semicolons deliberately do not clear it, so it
           has to be cleared here — otherwise a BRACELESS loop body
           (`for (int i=0;...) foo(1.5);`) inherits the int-statement state and
           every literal in it silently stays an int. */
        forDepth = -1;
        stmtIsInt = false;
        atStmtStart = true;
      }
      lastWord = '';
    } else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === ':') caseLabel = false;
    else if (c === ';' || c === '{' || c === '}') {
      if (!(forDepth >= 0 && paren > forDepth)) { stmtIsInt = false; atStmtStart = true; }
      lastWord = '';
    } else if (!/\s/.test(c)) { atStmtStart = false; lastWord = ''; }

    out += c;
    i++;
  }
  return out;
}

function lastNonSpace(s) {
  for (let i = s.length - 1; i >= 0; i--) if (!/\s/.test(s[i])) return s[i];
  return '';
}

function lastNonSpaceIdx(s, from) {
  for (let i = from; i >= 0; i--) if (!/\s/.test(s[i])) return i;
  return -1;
}

/* The mirror of the promoter: int VARIABLES compared or assigned against
   literals. voronoi_geode keeps an object id in `int id = 0;` and then writes
   `id = 1;`, `if (id == 1)`, `if (i % 2 == 0)` — the promoter has no per-variable
   type information, floats those literals, and the comparison stops type
   checking. Rather than give the transform a symbol table, collect the names
   declared int/uint and walk the promoted source back for exactly the operator
   forms where one side is provably an int. */
export function collectIntVars(src) {
  const names = new Set();
  const decl = /\b(?:int|uint)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/g;
  let m;
  while ((m = decl.exec(src))) {
    for (const part of m[1].split(',')) {
      const nm = part.trim();
      if (nm) names.add(nm);
    }
  }
  /* This is name-based, not scope-based, so a name that is ALSO declared float
     somewhere has to be dropped or the repairs below fire on the wrong one.
     Both spellings of `i` are everywhere: beamers has `for (int i = -2; ...)`
     in one function and `for (float i = 0.0; i < 60.0; ++i)` in another, and
     treating `i` as an int rewrote the float loop's literals back to ints —
     turning a scene that compiled into one that did not. */
  const fdecl = /\b(?:float|vec[234]|mat[234]|mat[234]x[234])\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/g;
  while ((m = fdecl.exec(src))) {
    for (const part of m[1].split(',')) names.delete(part.trim());
  }
  return names;
}

export function repairIntComparisons(src, intVars) {
  /* An explicit int() cast is an int too, and it is compared against literals
     constantly: `if (int(fragCoord.x) == 0)` (neuron_proximitors) reaches here
     as `== 0.0`. One level of nesting is enough for the shipped corpus —
     `int(clamp(y+y%3-3, 0, numToDraw))` is the deepest of them. */
  const CAST = 'int\\s*\\((?:[^()]|\\([^()]*\\))*\\)';
  const OPS = '==|!=|<=|>=|<|>';
  src = src.replace(new RegExp(`(${CAST})\\s*(${OPS})\\s*(-?\\d+)\\.0(?![0-9])`, 'g'),
    (all, cast, op, num) => `${cast} ${op} ${num}`);
  src = src.replace(new RegExp(`(-?\\d+)\\.0(?![0-9])\\s*(${OPS})\\s*(${CAST})`, 'g'),
    (all, num, op, cast) => `${num} ${op} ${cast}`);

  if (!intVars.size) return src;
  const names = [...intVars].sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const OP = '==|!=|<=|>=|<|>';

  // `id = 1.0` / `id == 1.0` / `id < 1.0` — a plain `=` only, never `+=`/`<=`
  src = src.replace(
    new RegExp(`\\b(${names})\\s*(${OP}|(?<![+\\-*/%&|^!<>=])=)\\s*(-?\\d+)\\.0(?![0-9])`, 'g'),
    (all, name, op, num) => `${name} ${op} ${num}`);

  // `1.0 == id`
  src = src.replace(
    new RegExp(`(-?\\d+)\\.0(?![0-9])\\s*(${OP})\\s*\\b(${names})\\b`, 'g'),
    (all, num, op, name) => `${num} ${op} ${name}`);

  // `i % 2 == 0.0` — the modulo of an int is an int, so the far side must be too
  src = src.replace(
    new RegExp(`\\b(${names})\\s*%\\s*(\\d+)(?:\\.0)?\\s*(${OP})\\s*(-?\\d+)\\.0(?![0-9])`, 'g'),
    (all, name, mod, op, num) => `${name} % ${mod} ${op} ${num}`);

  return src;
}

/* Collapse `true ? A : B` / `false ? A : B` to the branch that survives.
   Folding `_isMediaActive()` to a literal is what creates these, and one of
   them has to go: waterly writes `texMirror(_isMediaActive() ? syn_Media :
   image10, uv)`, and GLSL — desktop and ES alike — forbids a ternary whose
   operands are samplers. Choosing the branch at transform time is the only
   spelling that compiles, and it is what the desktop's media plumbing resolves
   to anyway once it knows whether media is loaded. */
export function foldConstantTernaries(src) {
  const re = /\b(true|false)\s*\?/g;
  let out = '', idx = 0, guard = 0;
  for (;;) {
    re.lastIndex = idx;
    const m = re.exec(src);
    if (!m || guard++ > 5000) break;
    const q = m.index + m[0].length - 1;      // the '?'
    const colon = findTernaryColon(src, q + 1);
    if (colon < 0) { out += src.slice(idx, q + 1); idx = q + 1; continue; }
    const end = ternaryEnd(src, colon + 1);
    const taken = m[1] === 'true'
      ? src.slice(q + 1, colon) : src.slice(colon + 1, end);
    out += src.slice(idx, m.index) + '(' + taken.trim() + ')';
    idx = end;
  }
  return out + src.slice(idx);
}

// the ':' pairing with this '?', skipping nested ternaries and anything inside
// parentheses or brackets
function findTernaryColon(s, from) {
  let depth = 0, q = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0) return -1; depth--; }
    else if (depth === 0 && c === '?') q++;
    else if (depth === 0 && c === ':') { if (q === 0) return i; q--; }
    else if (depth === 0 && (c === ';' || c === '{')) return -1;
  }
  return -1;
}

// end of the else-branch: a top-level `,` or `;`, or an unmatched closer
function ternaryEnd(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === ',' || c === ';')) return i;
  }
  return s.length;
}

/* ----------------------------------------------------------- for-headers
   The single most common compile failure across the corpus, by a wide margin:
   an int loop counter bounded by a float. Scenes expose iteration counts as
   SLIDER controls (which are floats) and then write

       for (int i = 0; i <= iters; i++)          // glob
       for (int i = 0; i < steps * 2.0; i++)     // several raymarchers

   Desktop GLSL promotes `i` and compares as float; ES 3.00 refuses. The literal
   promoter deliberately leaves whole for-headers alone (`i < 12` must stay int),
   so this is the targeted counterpart: only inside a for-header, only when the
   loop variable is the bare left operand, and only when the bound is not an
   integer literal, both sides are cast to float — which is exactly the desktop's
   implicit conversion, spelled out. The initializer gets the same treatment in
   reverse (`int i = someFloat` -> `int i = int(someFloat)`); int(int) is legal,
   so the cast is safe whichever type the bound really has. */
const FOR_COND = /^\s*([A-Za-z_]\w*)\s*(<=|>=|==|!=|<|>)\s*([\s\S]+?)\s*$/;
const FOR_INIT = /^\s*(?:const\s+)?(int|uint|float)\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/;
// a bound that is already a float literal needs no cast
const FLOAT_LIT = /^-?\d+\.\d*(?:[eE][-+]?\d+)?$/;

export function repairForHeaders(src, intMacros) {
  let out = '';
  let idx = 0;
  for (;;) {
    const at = src.indexOf('for', idx);
    if (at < 0) break;
    const before = at > 0 ? src[at - 1] : ' ';
    const openRel = src.slice(at + 3).search(/\S/);
    if (/[A-Za-z0-9_]/.test(before) || openRel < 0 || src[at + 3 + openRel] !== '(') {
      out += src.slice(idx, at + 3); idx = at + 3; continue;
    }
    const open = at + 3 + openRel;
    const close = matchParen(src, open);
    if (close < 0) { out += src.slice(idx, at + 3); idx = at + 3; continue; }

    const header = src.slice(open + 1, close);
    const parts = splitTopLevel(header, ';');
    let rebuilt = null;
    if (parts.length === 3) {
      const mi = FOR_INIT.exec(parts[0]);
      if (mi) {
        const [, type, name, initExpr] = mi;
        let init = parts[0], cond = parts[1];
        const isInt = type !== 'float';
        if (isInt && !/^-?\d+$/.test(initExpr) && !/^(?:int|uint)\s*\(/.test(initExpr)) {
          init = ` ${type} ${name} = int(${floatify(initExpr, intMacros)})`;
        } else if (!isInt && /\d/.test(initExpr)) {
          // a demoted counter's initializer is a float expression now, but its
          // literals were protected as for-header ints on the way through:
          // `for (float i = float(octaves-1); ...)` (exoplanet)
          init = ` ${type} ${name} = ${floatify(initExpr, intMacros)}`;
        }
        /* `for (int i = 0; i < MAXSTEPS && !hit; i++)` (party_doodad) is a
           conjunction, so the counter's own term is repaired in place and the
           other terms are left exactly as written. */
        const terms = splitTopLevelOp(parts[1], '&&');
        let condChanged = false;
        const fixedTerms = terms.map((term) => {
          const mc = FOR_COND.exec(term);
          if (!mc || mc[1] !== name) return term;
          const bound = mc[3];
          if (/(\|\||&&|\?)/.test(bound)) return term;
          if ((isInt ? /^-?\d+$/ : FLOAT_LIT).test(bound)) return term;
          condChanged = true;
          /* A float counter needs only its BOUND cast — which covers the
             counters demoteIntVars() just turned into floats, whose bounds are
             still `#define MAX_ITER 100` or `int(iters)`. float(float) is a
             no-op, so the cast is unconditional once the bound is not already
             a literal of the right kind. */
          return isInt
            ? ` float(${name}) ${mc[2]} float(${floatify(bound, intMacros)})`
            : ` ${name} ${mc[2]} float(${floatify(bound, intMacros)})`;
        });
        if (condChanged) cond = fixedTerms.join('&&');
        if (init !== parts[0] || cond !== parts[1]) {
          rebuilt = 'for (' + [init, cond, parts[2]].join(';') + ')';
        }
      }
    }
    out += src.slice(idx, at);
    out += rebuilt !== null ? rebuilt : src.slice(at, close + 1);
    idx = close + 1;
  }
  return out + src.slice(idx);
}

/* Once a for-bound is wrapped in float(), everything inside it is a float
   expression, and the literals the header protection deliberately left as ints
   have to come along: `float(i) < float(1+ringTime)` (compound_iris) is still
   int + float without this. Skipped where an int really is required — the lod
   argument of a texture query is the only such case that appears in a bound. */
function floatify(expr, intMacros) {
  if (/\b(?:texelFetch|textureSize)\b/.test(expr)) return expr;
  let out = expr.replace(/(^|[^\w.])(\d+)(?![\w.])/g, '$1$2.0');
  /* `#define OCTAVES 20` expands to an int literal the promoter never sees,
     so `for (int i = OCTAVES-1; ...)` becomes `OCTAVES - 1.0` unless the macro
     is floated with everything else (chroma_cascade, neuron_proximitors). */
  if (intMacros && intMacros.size) {
    out = out.replace(/\b[A-Za-z_]\w*\b/g,
      (w) => (intMacros.has(w) ? `float(${w})` : w));
  }
  // an int() cast inside the bound stays an int and would then be the odd one
  // out: `float(NUMPOINTS - 48.0 * int(fewer))` needs the cast floated too
  return floatWrapIntCalls(out);
}

/* Object-like macros whose body is a bare integer — the only macros a bound
   expression's type actually depends on. */
export function collectIntMacros(src) {
  const names = new Set();
  const re = /^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+\(?\s*(-?\d+)\s*\)?[ \t]*$/gm;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

// wrap every int()/uint() constructor call in float(), with real paren matching
function floatWrapIntCalls(expr) {
  let out = '', idx = 0;
  const word = /[A-Za-z_]\w*/g;
  for (;;) {
    const m = word.exec(expr);
    if (!m) break;
    if (m[0] !== 'int' && m[0] !== 'uint') continue;
    const rest = expr.slice(m.index + m[0].length);
    const lead = rest.search(/\S/);
    if (lead < 0 || rest[lead] !== '(') continue;
    const open = m.index + m[0].length + lead;
    const close = matchParen(expr, open);
    if (close < 0) continue;
    out += expr.slice(idx, m.index) + 'float(' + expr.slice(m.index, close + 1) + ')';
    idx = close + 1;
    word.lastIndex = idx;
  }
  return out + expr.slice(idx);
}

// split on a two-character operator at nesting depth 0
function splitTopLevelOp(s, op) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && s.startsWith(op, i)) {
      parts.push(s.slice(start, i)); start = i + op.length; i += op.length - 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// like splitArgs but on an arbitrary separator, honouring () [] nesting
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/* -------------------------------------------------------- int -> float vars
   The literal repairs above cannot reach an int VARIABLE used in float
   arithmetic — `value /= iters`, `random_spot * i`, `4.0 / (AA*AA)`. Casting
   every such use would need a type checker; changing the variable's own type
   does not, and lands in the same place, because the desktop was treating it as
   a float at those sites anyway.

   So: a scalar declared `int NAME = ...` becomes `float NAME = float(...)`,
   provided nothing in the scene needs it to really be an int. The
   disqualifiers are the places where GLSL has no float form at all:

     - an array subscript                      arr[i]
     - the integer-only operators              % << >> & | ^ ~
     - a whole argument of an int-taking call   texelFetch(t, c, lod), ivec2(i,j)
     - switch/case
     - a `return` (the function may be typed int)
     - any declaration of the same name WITHOUT an initializer, which is how
       function parameters and forward declarations look

   Loop counters demote cleanly: `i++`, `i--` and every comparison work on
   floats, and the literal promoter then floats the bounds because the header no
   longer reads as an int declaration. Anything disqualified keeps its int type
   and, if it is genuinely mixed with floats, fails loudly with its source
   line. */
const INT_OP_BEFORE = /([A-Za-z_]\w*)\s*(?:%|<<|>>|&(?!&)|\|(?!\|)|\^)/g;
const INT_OP_AFTER = /(?:%|<<|>>|&(?!&)|\|(?!\|)|\^|~)\s*([A-Za-z_]\w*)/g;

export function demoteIntVars(src) {
  const declRe = /(^|[^\w.])(?:const\s+)?(?:int|uint)\s+([A-Za-z_]\w*)\s*=/g;
  const cands = new Set();
  let m;
  while ((m = declRe.exec(src))) cands.add(m[2]);
  if (!cands.size) return src;

  const bad = new Set();
  const ban = (n) => { if (n) bad.add(n); };

  // a declaration with no initializer: parameter, prototype, plain `int i;`
  const plain = /\b(?:int|uint)\s+([A-Za-z_]\w*)\s*(?=[,;)\]])/g;
  while ((m = plain.exec(src))) ban(m[1]);
  // array subscripts
  const sub = /\[([^\]]*)\]/g;
  while ((m = sub.exec(src))) {
    for (const id of m[1].match(/[A-Za-z_]\w*/g) || []) ban(id);
  }
  INT_OP_BEFORE.lastIndex = 0;
  while ((m = INT_OP_BEFORE.exec(src))) ban(m[1]);
  INT_OP_AFTER.lastIndex = 0;
  while ((m = INT_OP_AFTER.exec(src))) ban(m[1]);
  const sw = /\b(?:switch\s*\(\s*|case\s+)([A-Za-z_]\w*)/g;
  while ((m = sw.exec(src))) ban(m[1]);
  const ret = /\breturn\s+([A-Za-z_]\w*)\s*;/g;
  while ((m = ret.exec(src))) ban(m[1]);

  // whole arguments of calls that require an int there
  const intCalls = new Set([...BUILTIN_INT_CALLS, ...findIntParamFunctions(src)]);
  const word = /[A-Za-z_]\w*/g;
  for (;;) {
    const w = word.exec(src);
    if (!w) break;
    if (!intCalls.has(w[0])) continue;
    const rest = src.slice(w.index + w[0].length);
    const lead = rest.search(/\S/);
    if (lead < 0 || rest[lead] !== '(') continue;
    const open = w.index + w[0].length + lead;
    const close = matchParen(src, open);
    if (close < 0) continue;
    for (const a of splitArgs(src.slice(open + 1, close))) {
      const t = a.trim();
      if (/^[A-Za-z_]\w*$/.test(t)) ban(t);
    }
  }

  const demote = new Set([...cands].filter((n) => !bad.has(n)));
  if (!demote.size) return src;

  // rewrite the declarations, wrapping each initializer so an int-valued
  // right-hand side still assigns (`int n = int(x)` -> `float n = float(int(x))`)
  let out = '';
  let idx = 0;
  declRe.lastIndex = 0;
  while ((m = declRe.exec(src))) {
    if (!demote.has(m[2])) continue;
    const eq = m.index + m[0].length - 1;      // position of the '='
    const end = initEnd(src, eq + 1);
    out += src.slice(idx, m.index) + m[1] + 'float ' + m[2] + ' = float('
         + src.slice(eq + 1, end) + ')';
    idx = end;
    declRe.lastIndex = end;
  }
  return out + src.slice(idx);
}

// end of an initializer expression: the next `;` `,` or `)` at nesting depth 0
function initEnd(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0) return i; depth--; }
    else if ((c === ';' || c === ',') && depth === 0) return i;
  }
  return src.length;
}

/* ------------------------------------------------ int values in float slots
   The mirror image of the literal promoter, and the single largest remaining
   failure class after it: an int-typed VARIABLE standing where a float belongs.
   `0.04 * i`, `pow(x, i)`, `i + 0.5` — all legal on the desktop, all rejected
   by ES 3.00, and none of them fixable by touching literals.

   No type inference here either: it matches only the two shapes where the float
   side is unambiguous from the text alone — an int variable directly against a
   float LITERAL, and an int variable passed whole to a builtin with no integer
   overload at all. Both are exactly the implicit conversion the desktop would
   have done, written out. Anything subtler (an int variable against a float
   variable, or against a parenthesized int sub-expression) is left to fail
   loudly with its source line. */
const FLOAT_ONLY_BUILTINS = new Set(['pow', 'mod', 'sin', 'cos', 'tan', 'asin',
  'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'exp2', 'log2', 'sqrt',
  'inversesqrt', 'fract', 'smoothstep', 'step', 'mix', 'radians', 'degrees',
  'length', 'normalize', 'floor', 'ceil', 'round']);

export function repairIntFloatMixing(src, intVars) {
  if (!intVars.size) return src;
  const names = [...intVars].sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const FLT = '-?\\d+\\.\\d*(?:[eE][-+]?\\d+)?';

  // `i * 0.5` / `i - 1.0`
  src = src.replace(new RegExp(`\\b(${names})\\s*([*/+\\-])\\s*(${FLT})`, 'g'),
    (all, name, op, num) => `float(${name}) ${op} ${num}`);
  // `0.04 * i`
  src = src.replace(new RegExp(`(${FLT})\\s*([*/+\\-])\\s*\\b(${names})\\b(?!\\s*\\()`, 'g'),
    (all, num, op, name) => `${num} ${op} float(${name})`);
  // `y / float(numToDraw)` — the other side is an explicit float cast, which is
  // as unambiguous as a literal
  src = src.replace(new RegExp(`\\b(${names})\\s*([*/+\\-])\\s*(?=float\\s*\\()`, 'g'),
    (all, name, op) => `float(${name}) ${op} `);
  src = src.replace(new RegExp(`(?<=\\bfloat\\s*\\([^()]*\\))\\s*([*/+\\-])\\s*\\b(${names})\\b(?!\\s*\\()`, 'g'),
    (all, op, name) => ` ${op} float(${name})`);

  // a bare int variable as a whole argument of an all-float builtin. The
  // argument list has to be matched with real paren counting, not a regex:
  // `mod((TIME*0.1 + syn_BassTime*0.25) + j, iters)` (replik8) is the shape
  // that actually needs fixing, and it nests two levels deep.
  const bare = new RegExp(`^\\s*(${names})\\s*$`);
  let out = '';
  let idx = 0;
  const nameRe = /[A-Za-z_]\w*/g;
  for (;;) {
    nameRe.lastIndex = idx;
    const m = nameRe.exec(src);
    if (!m) break;
    const fn = m[0];
    const after = src.slice(m.index + fn.length);
    const lead = after.search(/\S/);
    if (!FLOAT_ONLY_BUILTINS.has(fn) || lead < 0 || after[lead] !== '(') {
      out += src.slice(idx, m.index + fn.length); idx = m.index + fn.length; continue;
    }
    const open = m.index + fn.length + lead;
    const close = matchParen(src, open);
    if (close < 0) { out += src.slice(idx, open + 1); idx = open + 1; continue; }
    const parts = splitArgs(src.slice(open + 1, close));
    let touched = false;
    const fixed = parts.map((p) => {
      const b = bare.exec(p);
      if (!b) return p;
      touched = true;
      return ` float(${b[1]})`;
    });
    out += src.slice(idx, m.index);
    out += touched ? `${fn}(${fixed.join(',')})` : src.slice(m.index, close + 1);
    idx = close + 1;
  }
  return out + src.slice(idx);
}

/* Full desktop-GLSL -> GLSL ES 3.00 transform for one scene's main.glsl.
   `opts.media` decides how `_isMediaActive()` folds — see below. */
export function transformSource(raw, patches, opts) {
  let src = raw;
  for (const [from, to] of (patches || [])) {
    if (typeof from === 'string') src = src.split(from).join(to);
    else src = src.replace(from, to);
  }
  src = blankComments(src);

  /* Whether a media input exists is fixed for the lifetime of a scene here, so
     `_isMediaActive()` is a compile-time constant and folding it is both
     honest and useful: it dead-strips the branch that cannot run, and it is the
     only way to compile `texMirror(_isMediaActive() ? syn_Media : image10, ...)`
     (waterly) at all — ES 3.00 forbids a ternary on sampler types. */
  src = src.replace(/\b_isMediaActive\s*\(\s*\)/g,
    (opts && opts.media) ? 'true' : 'false');
  src = foldConstantTernaries(src);

  /* ES 3.00 has no initializers on uniforms; desktop GLSL allows them and
     exoplanet ships `uniform vec2 mousePos = vec2(0.5,0.5);`. The value is
     unreachable anyway — the runtime never uploads a scene-declared uniform it
     does not know — so dropping the initializer loses nothing real. */
  src = src.replace(/^([ \t]*uniform\s[^;=]*?)=[^;]*;/gm, '$1;');

  /* textureSize() returns ivec2. Desktop GLSL converts that to vec2 implicitly;
     ES 3.00 does not, and the scenes lean on it hard —
     `vec2 imgSize = textureSize(sampIn, 0)`, `1.0 / textureSize(image, 0)`,
     `textureSize(t, 0).x * 0.5`. Every call is wrapped in vec2() except the one
     spelling that genuinely wants the ivec2 (`ivec2 ts = textureSize(state, 0)`,
     fluid_body), which is left alone. */
  src = src.replace(/(\bivec2\s+\w+\s*=\s*)?(\btextureSize\s*\([^()]*\))/g,
    (all, ivecDecl, call) => (ivecDecl ? all : `vec2(${call})`));

  /* Order matters. The literal promoter runs FIRST so that the int expressions
     it protects (`int AA = 1 + int(x)`, `for (int i = OCTAVES-1; ...)`) are
     still whole ints when demotion wraps them in float() — floating the
     literals first would leave `float(1.0 + int(x))`, which is the very error
     being repaired. Demotion then runs before the two int repairs, because the
     names it converts are floats from that point on and must not be in the set
     those work from. */
  src = promoteIntLiterals(src);
  src = demoteIntVars(src);
  const intVars = collectIntVars(src);
  src = repairIntComparisons(src, intVars);
  src = repairIntFloatMixing(src, intVars);
  // PASSINDEX is an int; normalize `== 0.0` / `== 0.` (and anything the literal
  // promoter just turned into `== 0.0`) back to an int comparison
  src = src.replace(/\bPASSINDEX\s*(==|!=|<=|>=|<|>)\s*(-?\d+)(?:\.\d*)?/g, 'PASSINDEX $1 $2');
  src = repairForHeaders(src, collectIntMacros(src));
  src = rewriteDataTextures(src, ['syn_Spectrum', 'syn_LevelTrail']);
  return hoistGlobalInits(src);
}

/* ================================================================ the class */

const QUAD_VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

/* The shim owns this final blit, which makes it the one place a colour grade
   can be applied to every syn scene at once without touching a scene's own
   shader. `grade` is (hue radians, saturation, gamma, exposure) straight off
   SYN_GRADE; at its neutral value the branch skips the maths entirely.
   Hue rotation is the Rodrigues rotation of the RGB vector about the grey
   axis — three ops, no matrix upload, and exact at 0. */
const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 res;
uniform vec4 grade;
uniform sampler2D bg;      // the shared nebula, rendered in another context
uniform vec2 bgMix;        // (strength, chroma weight); x == 0 disables it all
out vec4 C;
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735026919);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
void main() {
  vec3 c = texture(src, gl_FragCoord.xy / res).rgb;
  if (grade != vec4(0.0, 1.0, 1.0, 1.0)) {
    c = hueRotate(c, grade.x);
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, grade.y);
    c = pow(max(c * grade.w, 0.0), vec3(grade.z));
  }
  /* Nebula backdrop, for the six black-and-white scenes that read as line art
     on black. The key is luminance MINUS chroma, so white areas fill with
     nebula, black stays black, and a saturated accent (FUZZY_SIGNAL's glitch
     colours) keeps its own colour instead of being replaced. Squaring the key
     in the mix keeps the mid-greys mostly scene, so the line work survives.
     Composited AFTER the grade on purpose: the nebula arrives ungraded, which
     is what keeps a palette cue's colours true on the TV.
     bgMix.x == 0 costs one compare — that is the other 80-odd scenes. */
  if (bgMix.x > 0.0) {
    vec3 neb = texture(bg, gl_FragCoord.xy / res).rgb;
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float chr  = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float key  = clamp(luma - bgMix.y * chr, 0.0, 1.0);
    c = mix(c, neb * (0.35 + 0.65 * key), bgMix.x * key * key);
  }
  C = vec4(c, 1.0);
}
`;

export class SynScene {
  /* opts:
       dir       scene folder URL (required)
       maxDim    cap on any buffer's longest side (default 1024). resize() reads
                 `this.maxDim` every frame, so it is live-mutable: assigning a
                 new cap reallocates the targets on the next frame. That is how
                 the gallery's quality slider works.
       dprCap    device-pixel-ratio cap (default 2)
       controls  { name: value } overrides on top of scene.json defaults
       patches   [[from, to], ...] literal/regex fixes applied to main.glsl
                 before transformation, for the int/float looseness a generic
                 rewriter cannot safely infer
       timeScale multiplier on TIME and the syn_*Time clocks (default 1)
       backdrop  this scene opts into the shared nebula backdrop: it gains two
                 synthetic controls (see _buildControls) and blends whatever
                 the host hands it in `backdropSource` through the final blit */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.dir = (this.opts.dir || '').replace(/\/$/, '');
    this.maxDim = this.opts.maxDim || 1024;
    this.dprCap = this.opts.dprCap || 2;
    this.timeScale = this.opts.timeScale || 1;

    this.ready = false;
    this.failed = false;
    this.gl = null;
    this.t0 = 0;
    this.frameCount = 0;

    this.audio = new SynAudio();
    this.synVals = {};          // reused object, no per-frame allocation
    this._uScratch = [0, 0, 0, 0];   // scratch for script uniform uploads
    this._unit = 0;             // texture unit cursor, reset per pass

    this.targets = [];          // one per PASSES entry, ping-ponged
    this.programs = [];         // one per pass (PASSES.length + 1)
    this.images = new Map();
    this.controls = [];
    this.script = null;

    this._loading = this._load().catch((err) => this._fail(err));
  }

  /* ------------------------------------------------------------- loading */
  async _load() {
    if (!this.dir) throw new Error('SynScene needs opts.dir');

    const [jsonText, glslText] = await Promise.all([
      fetchText(this.dir + '/scene.json'),
      fetchText(this.dir + '/main.glsl'),
    ]);
    const scene = JSON.parse(stripJsonComments(jsonText));
    this.scene = scene;
    this.title = scene.TITLE || this.dir.split('/').pop();

    // script.js is optional; a 404 is not an error
    let scriptText = null;
    try { scriptText = await fetchText(this.dir + '/script.js'); } catch (e) { /* none */ }

    this._buildControls(scene);
    this._buildPasses(scene);

    const gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable — Synesthesia scenes need it '
      + '(GLSL ES 3.00 is the closest browser target to their desktop GLSL 330)');
    this.gl = gl;
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
    this.floatLinearOK = !!gl.getExtension('OES_texture_float_linear');

    this._initQuad();
    this._initDataTextures();
    await this._loadImages(scene);

    if (scriptText) this._initScript(scriptText);

    this._compile(glslText);
    if (this.failed) return;

    this.t0 = performance.now() / 1000;
    this.ready = true;
    this.resize();
  }

  _buildControls(scene) {
    const over = this.opts.controls || {};
    for (const c of (scene.CONTROLS || [])) {
      const name = c.NAME;
      if (!name) continue;
      const type = String(c.TYPE || 'slider').toLowerCase();
      let value, glsl;
      if (type.includes('color')) {
        glsl = 'vec3';
        value = toArray(c.DEF_COLOR !== undefined ? c.DEF_COLOR : c.DEFAULT, 3, 0);
      } else if (type.includes('xy')) {
        glsl = 'vec2';
        value = toArray(c.DEFAULT, 2, 0);
      } else {
        glsl = 'float';
        // bangs and toggles with no DEFAULT rest at their MIN (usually 0)
        const d = c.DEFAULT !== undefined && c.DEFAULT !== null ? c.DEFAULT
                : (c.MIN !== undefined && c.MIN !== null ? c.MIN : 0);
        value = Number(d) || 0;
      }
      // the scene.json default, kept so a UI can offer "reset" without
      // re-reading (and re-parsing) the scene file
      const def = Array.isArray(value) ? value.slice() : value;
      if (name in over) {
        const o = over[name];
        value = Array.isArray(o) ? toArray(o, glsl === 'vec3' ? 3 : 2, 0) : o;
      }
      /* `spec` is the raw scene.json entry — TYPE / MIN / MAX / UI_GROUP /
         DESCRIPTION / LABELS. The runtime itself only needs name+glsl+value;
         the rest is carried for the gallery's control panel, which builds its
         widgets straight off this array. `value` is what _drawPass() uploads
         every frame, so mutating it is the whole live-control mechanism. */
      this.controls.push({ name, glsl, value, def, spec: c });
    }
    if (this.opts.backdrop) this._backdropControls(over);
  }

  /* The nebula backdrop's two knobs. They are ordinary `controls[]` rows, which
     is the entire trick: the gallery panel, the preset store and the show
     console's control report all walk that array and need no idea these two
     came from the runtime rather than from scene.json.

     `synth` keeps them OUT of _uniformBlock(), so no scene shader is handed a
     uniform it never declared and never reads. _drawPass's null-location guard
     would skip them anyway; not emitting them at all is simply the smaller
     blast radius across ~80 shaders. */
  _backdropControls(over) {
    const mk = (name, value, spec) => {
      const v = (name in over) && !Array.isArray(over[name]) ? Number(over[name]) : value;
      return { name, glsl: 'float', value: v, def: value, synth: true,
               spec: Object.assign({ NAME: name, UI_GROUP: 'nebula backdrop' }, spec) };
    };
    this.cBgOn = mk('BACKDROP_NEBULA', 1,
      { TYPE: 'toggle', MIN: 0, MAX: 1, DEFAULT: 1,
        DESCRIPTION: 'Show NEBULA through this scene\'s white areas. Off means '
          + 'zero backdrop work: nothing is rendered, uploaded or blended.' });
    this.cBgMix = mk('BACKDROP_MIX', 0.85,
      { TYPE: 'slider', MIN: 0, MAX: 1, DEFAULT: 0.85,
        DESCRIPTION: 'How far the white areas go over to the nebula. Below ~0.5 '
          + 'it reads as a tint on the scene rather than a window through it.' });
    /* PALETTE SWAP. A bang counter rather than a toggle because it is an
       EVENT, not a state: addSceneControl's 'bang counter' branch renders a
       button that does nothing but `value += 1`, and the host watches the
       number move. That is what lets the gallery panel's button and the
       console's remote push drive one mechanism — neither needs to know the
       other exists, and a counter survives the round trip through the preset
       store and POST /show/controls that a momentary edge would not. */
    this.cBgSwap = mk('BACKDROP_SWAP', 0,
      { TYPE: 'bang counter', MIN: 0, MAX: 1, DEFAULT: 0,
        DESCRIPTION: 'Step the backdrop nebula a golden angle round the hue '
          + 'circle — a different family of colour behind this scene on every '
          + 'press. Affects the shared backdrop only, never the scene itself.' });
    this.controls.push(this.cBgOn, this.cBgMix, this.cBgSwap);
  }

  // the host asks this before doing any work on the shared nebula at all
  backdropWanted() { return !!(this.cBgOn && this.cBgOn.value > 0.5); }

  _buildPasses(scene) {
    // Scene-authored output size; buffer sizes are kept in proportion to it so
    // a half-res simulation buffer stays half-res whatever the canvas is.
    this.sceneW = scene.WIDTH || 1920;
    this.sceneH = scene.HEIGHT || 1080;
    this.passDefs = (scene.PASSES || []).map((p) => ({
      target: p.TARGET,
      // 0 or absent means "same as the scene output"
      w: p.WIDTH || this.sceneW,
      h: p.HEIGHT || this.sceneH,
      float: p.FLOAT === undefined ? (p.TYPE === 'float' ? true : true) : !!p.FLOAT,
      wrap: (p.WRAP || 'repeat').toLowerCase(),
      filter: (p.FILTER || 'linear').toLowerCase(),
    }));
    this.nPasses = this.passDefs.length + 1;   // + the final on-screen pass
  }

  async _loadImages(scene) {
    const gl = this.gl;
    const list = scene.IMAGES || [];
    await Promise.all(list.map(async (im) => {
      if (!im || !im.NAME || !im.PATH) return;
      const tex = gl.createTexture();
      this.images.set(im.NAME, tex);
      // 1x1 placeholder so the sampler is always complete
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      try {
        const bmp = await loadImage(this.dir + '/' + im.PATH);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (isPow2(bmp.width) && isPow2(bmp.height)) gl.generateMipmap(gl.TEXTURE_2D);
        else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      } catch (e) {
        console.warn('[syn] image failed:', im.PATH, e);
      }
    }));
  }

  /* --------------------------------------------------------------- script
     Synesthesia scripts read audio and control values as bare globals (and via
     the older `inputs` object), and push shader uniforms by assigning to
     `uniforms` (or calling setUniform). Both styles are live in the shipped
     scenes, so both are supported.

     The sandbox is a `with`-scoped Function: bare reads resolve against the
     context object first and fall through to the script's own `var`s, which is
     exactly the desktop behaviour. `inputs` is a Proxy that answers 0 for
     unknown names — real scenes read controls that no longer exist
     (magnetismic reads `inputs.camera_speed`), and undefined would poison the
     accumulator with NaN. */
  _initScript(src) {
    const inputs = new Proxy({}, {
      get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? 0 : undefined)),
      has: () => true,
    });
    const uniforms = {};
    const ctx = {
      inputs, uniforms,
      setUniform: (name, ...rest) => { uniforms[name] = normUniform(rest); },
      setControl: () => {}, setControlNormalized: () => {},
      setControlDimension: () => {}, defaultControl: () => {},
      randomizeControl: () => {}, defaultGroup: () => {}, randomizeGroup: () => {},
      onChange: () => {}, onOffToOn: () => {}, onOnToOff: () => {},
      whileOn: () => {}, whileOff: () => {},
      textureFinalPass: () => [0, 0, 0],
      print: (...a) => console.log('[syn:' + this.title + ']', ...a),
    };
    ctx.console = { log: ctx.print };
    this.scriptInputsTarget = inputs;
    this.scriptUniforms = uniforms;
    this.scriptCtx = ctx;

    try {
      // non-strict on purpose: `with` needs it, and it is what gives scripts
      // the bare-global reads their authors wrote against
      const make = new Function('__ctx', 'with (__ctx) {\n' + src
        + '\n; return { setup: typeof setup === "function" ? setup : null,'
        + ' update: typeof update === "function" ? update : null }; }');
      this.script = make(ctx);
    } catch (err) {
      console.warn('[syn] script.js failed to parse, continuing without it:', err);
      this.script = null;
      return;
    }

    // Run setup() and one update() before compiling: the shader needs the
    // script's uniform NAMES to declare them, and the docs tell authors to
    // establish them up front for exactly this reason.
    this._feedScriptInputs({ level: 0, beat: 0 });
    this._runScript('setup', 0);
    this._runScript('update', 1 / 60);
  }

  _runScript(which, dt) {
    if (!this.script || !this.script[which]) return;
    try { this.script[which](dt); }
    catch (err) {
      console.warn('[syn] script.' + which + '() threw, disabling:', err);
      this.script = null;
    }
  }

  /* Push this frame's values into the script's scope. Every vector wrapper is
     allocated once and mutated in place — this runs on every frame of every
     scripted scene, so building fresh {x,y,z} objects here would be thousands
     of dead objects a second. */
  _feedScriptInputs() {
    const t = this.scriptInputsTarget;
    if (!t) return;
    const ctx = this.scriptCtx;
    if (!this._vecCache) {
      this._vecCache = new Map();
      const mk = (name, o) => { t[name] = o; ctx[name] = o; return o; };
      this._click = mk('_click', { x: 0, y: 0, z: 0 });
      this._muvIn = mk('_muv', { x: 0.5, y: 0.5 });
      this._muvcIn = mk('_muvc', { x: 0, y: 0 });
      for (const c of this.controls) {
        if (!Array.isArray(c.value)) continue;
        this._vecCache.set(c.name, mk(c.name, { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 }));
      }
    }
    for (const k in this.synVals) { t[k] = this.synVals[k]; ctx[k] = this.synVals[k]; }
    for (const c of this.controls) {
      if (Array.isArray(c.value)) {
        const o = this._vecCache.get(c.name);
        o.x = o.r = c.value[0]; o.y = o.g = c.value[1];
        o.z = o.b = c.value[2] || 0;
      } else { t[c.name] = c.value; ctx[c.name] = c.value; }
    }
    t.TIME = ctx.TIME = this.time || 0;
    t.FRAMECOUNT = ctx.FRAMECOUNT = this.frameCount;
  }

  /* -------------------------------------------------------------- shaders */
  _uniformBlock() {
    const L = [];
    L.push('uniform vec2 RENDERSIZE;');
    L.push('uniform float TIME;');
    L.push('uniform float FRAMECOUNT;');
    L.push('uniform vec4 _mouse;');
    L.push('uniform vec3 _click;');
    L.push('uniform vec2 _muv;');
    L.push('uniform vec2 _muvc;');
    for (const n of SYN_FLOAT_UNIFORMS) L.push(`uniform float ${n};`);
    for (const n of META_FLOAT_UNIFORMS) L.push(`uniform float ${n};`);
    for (const n of META_VEC3_UNIFORMS) L.push(`uniform vec3 ${n};`);
    for (const n of SYN_SAMPLER_UNIFORMS) L.push(`uniform sampler2D ${n};`);
    for (const c of this.controls) {
      if (c.synth) continue;      // runtime-owned, never read by scene GLSL
      L.push(`uniform ${c.glsl} ${c.name};`);
    }
    for (const name of this.images.keys()) L.push(`uniform sampler2D ${name};`);
    for (const p of this.passDefs) L.push(`uniform sampler2D ${p.target};`);
    // transition uniforms exist in ~a third of scenes; declare them so those
    // scenes link, held at their first / first-is-on value
    this.transitions = [];
    for (const t of (this.scene.HARD_TRANSITIONS || [])) {
      if (!t || !t.UNIFORM) continue;
      const v = Array.isArray(t.VALUES) && t.VALUES.length ? Number(t.VALUES[0]) : 0;
      this.transitions.push({ name: t.UNIFORM, value: v });
      L.push(`uniform float ${t.UNIFORM};`);
    }
    for (const t of (this.scene.SMOOTH_TRANSITIONS || [])) {
      const names = (t && t.UNIFORMS) || [];
      names.forEach((n, i) => {
        this.transitions.push({ name: n, value: i === 0 ? 1 : 0 });
        L.push(`uniform float ${n};`);
      });
    }
    // script-pushed uniforms, typed by the arity the script produced
    this.scriptNames = [];
    if (this.scriptUniforms) {
      for (const k of Object.keys(this.scriptUniforms)) {
        const arity = uniformArity(this.scriptUniforms[k]);
        if (!arity) continue;
        this.scriptNames.push({ name: k, arity });
        L.push(`uniform ${['float', 'vec2', 'vec3', 'vec4'][arity - 1]} ${k};`);
      }
    }
    return L.join('\n');
  }

  _compile(glslText) {
    const gl = this.gl;
    const { source, init } = transformSource(glslText, this.opts.patches,
      { media: !!this.opts.media });
    const head = '#version 300 es\n'
      + 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n'
      + this._uniformBlock() + '\n'
      + GLSL_GLOBALS + GLSL_LIB;
    const tail = '\nout vec4 _COLOR_OUT_;\n'
      + 'void _initGlobals() {\n' + GLSL_GLOBAL_INIT + init + '\n}\n'
      + 'void main() { _initGlobals(); _COLOR_OUT_ = renderMain(); }\n';

    this.vs = compileShader(gl, gl.VERTEX_SHADER, QUAD_VS);
    for (let i = 0; i < this.nPasses; i++) {
      const full = head + `\n#define PASSINDEX ${i}\n` + source + tail;
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, full);
      if (!fs.ok) {
        this._fail(new Error('pass ' + i + ' failed to compile:\n' + fs.log),
          annotate(full, fs.log));
        return;
      }
      const prog = linkProgram(gl, this.vs.shader, fs.shader);
      gl.deleteShader(fs.shader);
      if (!prog.ok) { this._fail(new Error('pass ' + i + ' link failed:\n' + prog.log)); return; }
      this.programs.push({ prog: prog.prog, loc: new Map() });
    }
    const blitFs = compileShader(gl, gl.FRAGMENT_SHADER, BLIT_FS);
    this.blit = linkProgram(gl, this.vs.shader, blitFs.shader).prog;
    gl.deleteShader(blitFs.shader);
    this.blitSrc = gl.getUniformLocation(this.blit, 'src');
    this.blitRes = gl.getUniformLocation(this.blit, 'res');
    this.blitGrade = gl.getUniformLocation(this.blit, 'grade');
    this.blitBg = gl.getUniformLocation(this.blit, 'bg');
    this.blitBgMix = gl.getUniformLocation(this.blit, 'bgMix');
  }

  _initQuad() {
    const gl = this.gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _initDataTextures() {
    const gl = this.gl;
    const useFloat = this.floatLinearOK;
    const mk = (w) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (useFloat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, 1, 0, gl.RGBA, gl.FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.dataFloat = useFloat;
    this.texSpectrum = mk(SPECTRUM_BINS);
    this.texTrail = mk(TRAIL_BINS);
    if (!useFloat) {
      this.specBytes = new Uint8Array(SPECTRUM_BINS * 4);
      this.trailBytes = new Uint8Array(TRAIL_BINS * 4);
    }
    // 1x1 stand-ins for the media inputs this shim does not have
    this.texBlack = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texBlack);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    /* opts.media: a synthetic stand-in for the webcam/video/still a
       media-dependent scene expects. `syn_Media` gates the OUTPUT of ~17 scenes
       (hextunnel multiplies its whole colour by a media sample), so with the
       1x1 transparent default they are simply black. A generated stand-in
       is not the scene's intent, but it is enough to show the geometry working
       — and it is generated, never a file of the user's. Off by default: the
       scenes that branch on `_isMediaActive()` have a no-media look their
       author designed, and that one stays the default.

       The stand-in is a small offscreen canvas repainted a few times a
       second with soft drifting colour blobs — meant to read as "some video
       is playing" once a scene samples/warps/tiles it, not as a calibration
       chart. No hard edges or grid: scenes reflect/kaleidoscope this texture,
       so any border in the source becomes a very visible box in the output. */
    if (this.opts.media) {
      this.mediaSize = MEDIA_TEX_SIZE;
      this.mediaCanvas = document.createElement('canvas');
      this.mediaCanvas.width = this.mediaCanvas.height = this.mediaSize;
      this.mediaCtx = this.mediaCanvas.getContext('2d');
      this.mediaBlobs = makeMediaBlobs();
      this.mediaGrain = makeMediaGrain(this.mediaSize);
      this._mediaAcc = 0;
      paintMediaFrame(this.mediaCtx, this.mediaSize, 0, this.mediaBlobs, 0, this.mediaGrain);

      this.texMedia = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texMedia);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
        this.mediaCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  /* Repaints the media stand-in canvas and re-uploads it, throttled to
     ~30Hz regardless of display refresh rate. `dt` is real seconds (see
     render()); mild audio reactivity rides on `this.audio.intensity`, a
     already-smoothed 0..1 loudness value written by SynAudio.update(). */
  _updateMediaTexture(dt) {
    const MEDIA_INTERVAL = 1 / 30;
    this._mediaAcc += dt;
    if (this._mediaAcc < MEDIA_INTERVAL) return;
    this._mediaAcc = 0;
    const gl = this.gl;
    paintMediaFrame(this.mediaCtx, this.mediaSize, this.time,
      this.mediaBlobs, this.audio.intensity || 0, this.mediaGrain);
    gl.bindTexture(gl.TEXTURE_2D, this.texMedia);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE,
      this.mediaCanvas);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /* --------------------------------------------------------------- sizing */
  resize() {
    if (!this.gl || this.failed) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    let cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) {
      const host = this.canvas.parentElement;
      if (host) { cw = cw || host.clientWidth; ch = ch || host.clientHeight; }
    }
    if (!cw || !ch) return;
    let w = Math.max(1, Math.round(cw * dpr));
    let h = Math.max(1, Math.round(ch * dpr));
    const s = Math.min(1, this.maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
    if (this.canvas.width === w && this.canvas.height === h && this.targets.length) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this._allocTargets(w, h);
  }

  _allocTargets(w, h) {
    const gl = this.gl;
    for (const t of this.targets) t.dispose();
    this.targets = [];
    for (const p of this.passDefs) {
      // keep each buffer's resolution proportional to what the scene authored
      const scale = Math.min(p.w / this.sceneW, p.h / this.sceneH, 1);
      const bw = Math.max(1, Math.min(this.maxDim, Math.round(w * scale)));
      const bh = Math.max(1, Math.min(this.maxDim, Math.round(h * scale)));
      this.targets.push(new PingPong(gl, bw, bh, p, this.floatOK, this.floatLinearOK));
    }
    this.finalTarget = new PingPong(gl, w, h,
      { wrap: 'clamp', filter: 'linear', float: false }, this.floatOK, this.floatLinearOK);
    if (this._pendingMessage) this._paintMessage(this._pendingMessage);
  }

  /* ---------------------------------------------------------------- render */
  render(frame, now, dt) {
    if (this.failed) { this._paintMessage(this._pendingMessage); return; }
    if (!this.ready) return;
    const gl = this.gl;
    this.resize();
    // resize() bails out when the canvas has no layout box yet (hidden tab,
    // display:none card), and then there is nothing allocated to draw into.
    // Testing finalTarget rather than targets.length is what covers the
    // single-pass scenes, which have no PASSES entries at all.
    if (!this.finalTarget) return;
    if (!this.targets.length && this.passDefs.length) return;

    this.time = (now - this.t0) * this.timeScale;
    this.frameCount++;

    this.audio.update(frame, dt);
    this.audio.writeUniforms(this.synVals, frame);
    // 1 == "an image is loaded", which is what `_isMediaActive()` tests
    if (this.texMedia) {
      this.synVals.syn_MediaType = 1;
      this._updateMediaTexture(dt);
    }

    // script.js runs before the shader, per the docs
    if (this.script) {
      this._feedScriptInputs(frame);
      this._runScript('update', dt);
    }
    this._uploadDataTextures();

    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    for (let i = 0; i < this.nPasses; i++) {
      const isFinal = i === this.passDefs.length;
      const dstT = isFinal ? this.finalTarget : this.targets[i];
      if (!dstT) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstT.backFbo());
      gl.viewport(0, 0, dstT.w, dstT.h);
      this._drawPass(i, dstT.w, dstT.h);
      // swap immediately: later passes must see this pass's NEW output, while
      // a pass sampling its own target already read the old one
      dstT.swap();
    }

    const bgOn = this._uploadBackdrop();

    // blit the final target to the canvas (it stays live as syn_FinalPass)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.finalTarget.front().tex);
    gl.uniform1i(this.blitSrc, 0);
    gl.uniform2f(this.blitRes, this.canvas.width, this.canvas.height);
    gl.uniform4f(this.blitGrade, SYN_GRADE.hue, SYN_GRADE.sat,
                 SYN_GRADE.gamma, SYN_GRADE.exposure);
    /* Unit 1 is free here: _drawPass walks this._unit from 0 and rebinds every
       unit it uses on every pass, so nothing carries between the two programs.
       The sampler is bound even when the backdrop is off — it survives
       compilation under a dynamic branch, and an incomplete texture on a live
       sampler is undefined behaviour whether or not the branch is taken. */
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texBackdrop || this.texBlack);
    gl.uniform1i(this.blitBg, 1);
    gl.uniform2f(this.blitBgMix, bgOn ? this.cBgMix.value : 0, 1.5);
    gl.activeTexture(gl.TEXTURE0);   // leave the cursor where the rest expects it
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /* Pull this frame of the shared nebula into THIS context. It is rendered by
     the host into a detached canvas by a separate WebGL context, so a texture
     cannot be shared — the pixels have to make the round trip. At 960x540 that
     is ~2 MB a frame, sub-millisecond on the rig this show runs on, and it
     only happens for a scene that asked for it.

     Returns whether the blit should blend it: false means the branch is off
     and no nebula work of any kind happened this frame. */
  _uploadBackdrop() {
    const src = this.backdropSource;
    if (!src || !src.width || !src.height || !this.backdropWanted()) return false;
    const gl = this.gl;
    if (!this.texBackdrop) {
      this.texBackdrop = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texBackdrop);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // the backdrop is sampled at screen coordinates and never tiles; REPEAT
      // would smear the far edge into the near one on a size mismatch
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texBackdrop);
    // GL's origin is bottom-left and a canvas's is top-left; without the flip
    // the nebula arrives upside down
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // every other upload assumes false
    return true;
  }

  _drawPass(i, w, h) {
    const gl = this.gl;
    const P = this.programs[i];
    if (!P) return;
    gl.useProgram(P.prog);
    const U = (n) => {
      if (!P.loc.has(n)) P.loc.set(n, gl.getUniformLocation(P.prog, n));
      return P.loc.get(n);
    };

    gl.uniform2f(U('RENDERSIZE'), w, h);
    gl.uniform1f(U('TIME'), this.time);
    gl.uniform1f(U('FRAMECOUNT'), this.frameCount);
    gl.uniform4f(U('_mouse'), w * 0.5, h * 0.5, -1, -1);
    gl.uniform3f(U('_click'), 0, 0, 0);
    gl.uniform2f(U('_muv'), 0.5, 0.5);
    gl.uniform2f(U('_muvc'), 0, 0);

    for (const n of SYN_FLOAT_UNIFORMS) {
      const l = U(n);
      if (l) gl.uniform1f(l, safe(this.synVals[n]));
    }
    for (const n of META_FLOAT_UNIFORMS) {
      const l = U(n);
      if (l) gl.uniform1f(l, META_DEFAULTS[n] || 0);
    }
    for (const n of META_VEC3_UNIFORMS) {
      const l = U(n);
      if (l) gl.uniform3f(l, 0, 0, 0);
    }
    for (const c of this.controls) {
      const l = U(c.name);
      if (!l) continue;
      if (c.glsl === 'vec3') gl.uniform3f(l, c.value[0], c.value[1], c.value[2]);
      else if (c.glsl === 'vec2') gl.uniform2f(l, c.value[0], c.value[1]);
      else gl.uniform1f(l, safe(c.value));
    }
    for (const t of (this.transitions || [])) {
      const l = U(t.name);
      if (l) gl.uniform1f(l, t.value);
    }
    const a = this._uScratch;
    for (const s of (this.scriptNames || [])) {
      const l = U(s.name);
      if (!l) continue;
      uniformValues(this.scriptUniforms[s.name], s.arity, a);
      if (s.arity === 1) gl.uniform1f(l, a[0]);
      else if (s.arity === 2) gl.uniform2f(l, a[0], a[1]);
      else if (s.arity === 3) gl.uniform3f(l, a[0], a[1], a[2]);
      else gl.uniform4f(l, a[0], a[1], a[2], a[3]);
    }

    // texture units: data textures, media stand-ins, then images, then passes
    this._unit = 0;
    this._bind(U, 'syn_Spectrum', this.texSpectrum);
    this._bind(U, 'syn_LevelTrail', this.texTrail);
    this._bind(U, 'syn_Media', this.texMedia || this.texBlack);
    this._bind(U, 'syn_UserImage', this.texMedia || this.texBlack);
    this._bind(U, 'syn_FinalPass', this.finalTarget.front().tex);
    for (const [name, tex] of this.images) this._bind(U, name, tex);
    for (let k = 0; k < this.passDefs.length; k++) {
      const t = this.targets[k];
      if (t) this._bind(U, this.passDefs[k].target, t.front().tex);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // a method rather than a closure so no function object is created per pass
  _bind(U, name, tex) {
    const l = U(name);
    if (!l) return;              // uniform optimized out; do not burn a unit
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + this._unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(l, this._unit);
    this._unit++;
  }

  _uploadDataTextures() {
    const gl = this.gl;
    const a = this.audio;
    gl.bindTexture(gl.TEXTURE_2D, this.texSpectrum);
    if (this.dataFloat) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPECTRUM_BINS, 1, gl.RGBA, gl.FLOAT, a.spectrum);
    } else {
      toBytes(a.spectrum, this.specBytes);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPECTRUM_BINS, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.specBytes);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texTrail);
    if (this.dataFloat) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TRAIL_BINS, 1, gl.RGBA, gl.FLOAT, a.trail);
    } else {
      toBytes(a.trail, this.trailBytes);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TRAIL_BINS, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.trailBytes);
    }
  }

  /* ------------------------------------------------------------- failure
     A compile log is the most useful thing a port can show, so it goes on the
     canvas rather than up the stack: throwing here would turn the gallery card
     into a stack trace with the GLSL error buried in it. */
  _fail(err, detail) {
    this.failed = true;
    this.ready = false;
    let msg = String((err && (err.message || err)) || 'unknown error');
    // scene folders are licensed content and gitignored, so a fresh clone hits
    // this first: say so rather than leaving a bare 404 on the canvas
    if (/^404\b/.test(msg)) {
      msg = 'scene folder not found — ' + this.dir + '\n\n'
        + 'demos/syn/scenes/ is gitignored (Synesthesia scenes are licensed\n'
        + 'content, not redistributable). Copy the .synScene folder in from\n'
        + 'your Synesthesia install to run this demo.';
    }
    console.error('[syn] ' + (this.title || this.dir), err, detail || '');
    this._pendingMessage = [
      'syn scene: ' + (this.title || this.dir.split('/').pop()),
      ...msg.split('\n').slice(0, 14),
    ];
    this._paintMessage(this._pendingMessage);
  }

  _paintMessage(lines) {
    if (!lines) return;
    const gl = this.gl;
    if (!gl) { canvas2dMessage(this.canvas, lines); return; }
    // there is already a WebGL context on this canvas, so 2D is unavailable:
    // render the text through an offscreen 2D canvas as a texture
    try {
      const w = this.canvas.width || 640, h = this.canvas.height || 360;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      draw2dText(off, lines);
      if (!this.msgTex) this.msgTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.msgTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (!this.blit) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.bindVertexArray(this.vao);
      gl.useProgram(this.blit);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.msgTex);
      gl.uniform1i(this.blitSrc, 0);
      gl.uniform2f(this.blitRes, w, h);
      gl.uniform4f(this.blitGrade, 0, 1, 1, 1);   // never grade an error card
      // uniforms are per-PROGRAM state and this shares the blit program with
      // render(): without zeroing it, a backdrop scene that fails to compile
      // would key its own error text into the nebula
      gl.uniform2f(this.blitBgMix, 0, 1.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    } catch (e) { /* nothing else we can do */ }
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    for (const t of this.targets) t.dispose();
    if (this.finalTarget) this.finalTarget.dispose();
    for (const p of this.programs) gl.deleteProgram(p.prog);
    if (this.texBackdrop) { gl.deleteTexture(this.texBackdrop); this.texBackdrop = null; }
    this.targets = []; this.programs = [];
    this.ready = false;
  }
}

/* ------------------------------------------------------- pass ping-pong
   Two textures per target. Reads bind front(); writes go to back(); swap()
   after the draw promotes it. That is what makes a pass reading its own target
   see the previous frame while a later pass sees the current one. */
class PingPong {
  constructor(gl, w, h, def, floatOK, floatLinearOK) {
    this.gl = gl; this.w = w; this.h = h;
    const wantFloat = def.float && floatOK;
    const linear = def.filter !== 'nearest' && (!wantFloat || floatLinearOK);
    const wrap = def.wrap === 'clamp' ? gl.CLAMP_TO_EDGE
               : def.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.REPEAT;
    this.bufs = [0, 1].map(() => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (wantFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      // scenes assume every buffer starts at vec4(0.0)
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo };
    });
    this.i = 0;
  }
  front() { return this.bufs[this.i]; }
  backFbo() { return this.bufs[1 - this.i].fbo; }
  swap() { this.i = 1 - this.i; }
  dispose() {
    for (const b of this.bufs) { this.gl.deleteTexture(b.tex); this.gl.deleteFramebuffer(b.fbo); }
    this.bufs = [];
  }
}

/* ------------------------------------------------------------- utilities */

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText + ' — ' + url);
  return r.text();
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('image load failed: ' + url));
    im.src = url;
  });
}

/* A few shipped scene.json files carry // comments and trailing commas. This
   cannot reuse blankComments(): JSON has string literals, and several
   DESCRIPTION fields contain a literal " // " ("Mouse Axis X => Grow Up/Down //
   Mouse Axis Y => Density", hexoplanet). Blanking from there to the end of line
   eats the closing quote and the file stops being JSON, so the scanner has to
   know when it is inside a string. */
function stripJsonComments(s) {
  let out = '';
  let i = 0, inStr = false;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += s[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
    } else { out += c; i++; }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  return { ok, shader, log: ok ? '' : gl.getShaderInfoLog(shader) || '' };
}

function linkProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
  return { ok, prog, log: ok ? '' : gl.getProgramInfoLog(prog) || '' };
}

/* Pull the offending source lines out of a compile log so the on-canvas
   message shows the code, not just "ERROR: 0:412". */
function annotate(src, log) {
  const lines = src.split('\n');
  const out = [];
  const re = /(\d+):(\d+)/g;
  let m;
  while ((m = re.exec(log))) {
    const n = parseInt(m[2], 10);
    if (n > 0 && n <= lines.length) out.push(n + ': ' + lines[n - 1].trim());
  }
  return out.join('\n');
}

function toArray(v, n, fill) {
  const out = new Array(n).fill(fill);
  if (Array.isArray(v)) for (let i = 0; i < n; i++) out[i] = Number(v[i]) || 0;
  else if (typeof v === 'number') out.fill(v);
  return out;
}

function normUniform(rest) {
  if (rest.length === 1 && Array.isArray(rest[0])) return rest[0].slice(0, 4);
  if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') return rest[0];
  if (rest.length === 1) return Number(rest[0]);
  return rest.slice(0, 4).map(Number);
}

function uniformArity(v) {
  if (typeof v === 'number') return 1;
  if (Array.isArray(v)) return Math.min(4, Math.max(1, v.length));
  if (v && typeof v === 'object') {
    const k = ['x', 'y', 'z', 'w'].filter((c) => typeof v[c] === 'number').length
           || ['r', 'g', 'b', 'a'].filter((c) => typeof v[c] === 'number').length;
    return k || 0;
  }
  return 0;
}

const XYZW = ['x', 'y', 'z', 'w'], RGBA = ['r', 'g', 'b', 'a'];

// writes into the caller's scratch array rather than returning a fresh one
function uniformValues(v, arity, out) {
  out[0] = out[1] = out[2] = out[3] = 0;
  if (typeof v === 'number') out[0] = safe(v);
  else if (Array.isArray(v)) for (let i = 0; i < arity; i++) out[i] = safe(v[i]);
  else if (v && typeof v === 'object') {
    const keys = typeof v.x === 'number' ? XYZW : RGBA;
    for (let i = 0; i < arity; i++) out[i] = safe(v[keys[i]]);
  }
  return out;
}

// NaN/Infinity in a uniform poisons a whole frame; scripts produce both
function safe(x) { return Number.isFinite(x) ? x : 0; }

function toBytes(src, dst) {
  for (let i = 0; i < dst.length; i++) {
    const v = src[i];
    dst[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
  }
}

function isPow2(x) { return (x & (x - 1)) === 0; }

// side of the media stand-in canvas, in px — small and cheap, per the media
// texture's own comment: scenes only ever sample it heavily minified/tiled.
const MEDIA_TEX_SIZE = 320;
const MEDIA_BLOB_COUNT = 6;

/* Fixed per-blob drift parameters, allocated once and reused every repaint —
   no per-frame allocation. Each blob wanders its own slow Lissajous-ish path
   so the whole canvas never repeats in an obvious loop. */
function makeMediaBlobs() {
  const blobs = [];
  for (let i = 0; i < MEDIA_BLOB_COUNT; i++) {
    blobs.push({
      // orbit center + radii, in unit [0,1] canvas space
      cx: 0.2 + 0.6 * ((i * 0.61803399) % 1),
      cy: 0.2 + 0.6 * ((i * 0.83920783) % 1),
      ax: 0.22 + 0.15 * ((i * 0.37) % 1),
      ay: 0.22 + 0.15 * ((i * 0.29) % 1),
      // angular speed + phase: slow, each blob different so motion feels organic
      wx: 0.06 + 0.05 * ((i * 0.71) % 1),
      wy: 0.05 + 0.06 * ((i * 0.53) % 1),
      phase: i * 1.7,
      hue: (i * 360 / MEDIA_BLOB_COUNT) % 360,
      radius: 0.30 + 0.12 * ((i * 0.44) % 1),
    });
  }
  return blobs;
}

/* A small pre-rendered plasma-noise field, computed once and reused as a
   texture-detail layer (blitted, never regenerated per frame). It exists
   because some media-gated scenes run an edge detector over syn_Media —
   smooth blob gradients alone are almost gradient-free at the single-texel
   sampling step those scenes use, so they'd render as nearly blank. Built
   from a handful of sine terms at integer cycle counts across `size`, which
   makes it exactly seamless under REPEAT wrap with no visible seam or grid,
   reading as fine organic video grain rather than geometry. */
function makeMediaGrain(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const terms = [
    { fx: 3, fy: 5, phase: 0.3, amp: 1.0 },
    { fx: 7, fy: 2, phase: 2.1, amp: 0.6 },
    { fx: 5, fy: 9, phase: 4.0, amp: 0.45 },
    { fx: 11, fy: 4, phase: 1.2, amp: 0.3 },
    { fx: 2, fy: 13, phase: 5.4, amp: 0.25 },
  ];
  const norm = terms.reduce((s, t) => s + t.amp, 0);
  const TWO_PI = Math.PI * 2;
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const t of terms) {
        v += t.amp * Math.sin(TWO_PI * (t.fx * x / size + t.fy * y / size) + t.phase);
      }
      const g = Math.max(0, Math.min(255, ((0.5 + 0.5 * (v / norm)) * 255) | 0));
      const idx = (y * size + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = g;
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/* Paints the media stand-in: a dark warm-to-cool base wash with soft,
   borderless colour blobs drifting across it, finished with a faint plasma
   grain for local detail — meant to read as "some video is playing" once a
   scene samples/warps/tiles it, never as a test card. Blobs are drawn with
   feathered radial gradients (no hard edges) and are echoed at wrapped
   offsets near the canvas edges so the texture tiles seamlessly under the
   scenes' REPEAT wrap. `level` (0..1, already smoothed upstream) gives mild
   audio reactivity via blob glow and drift speed. */
function paintMediaFrame(ctx, size, t, blobs, level, grain) {
  const boost = 1 + 0.35 * level;

  // slowly rotating dark base wash, warm-to-cool — never flat black so
  // difference/luma-keying scenes still have something to read
  const baseHue = (200 + 40 * Math.sin(t * 0.05)) % 360;
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, `hsl(${baseHue}, 55%, 10%)`);
  g.addColorStop(1, `hsl(${(baseHue + 80) % 360}, 55%, 6%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  ctx.globalCompositeOperation = 'lighter';
  for (const b of blobs) {
    const x = (b.cx + b.ax * Math.sin(t * b.wx + b.phase)) * size;
    const y = (b.cy + b.ay * Math.cos(t * b.wy + b.phase * 1.3)) * size;
    const r = b.radius * size * boost;
    const hue = (b.hue + t * 4) % 360;
    // draw the blob plus wrapped echoes for any edge it currently overlaps,
    // so the tiled texture has no visible seam
    for (const dx of (x - r < 0 ? [0, size] : x + r > size ? [0, -size] : [0])) {
      for (const dy of (y - r < 0 ? [0, size] : y + r > size ? [0, -size] : [0])) {
        const grad = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        grad.addColorStop(0, `hsla(${hue}, 80%, ${55 + 10 * level}%, 0.55)`);
        grad.addColorStop(0.6, `hsla(${hue}, 75%, 42%, 0.28)`);
        grad.addColorStop(1, `hsla(${hue}, 70%, 30%, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
      }
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  if (grain) {
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.6 + 0.15 * level;
    ctx.drawImage(grain, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

function draw2dText(canvas, lines) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#04070a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffb13d';
  ctx.font = '13px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  const pad = 18;
  lines.forEach((s, i) => ctx.fillText(String(s).slice(0, 110), pad, pad + 20 + i * 18));
}

function canvas2dMessage(canvas, lines) {
  try {
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    canvas.width = w; canvas.height = h;
    draw2dText(canvas, lines);
  } catch (e) { /* the canvas already has a GL context */ }
}

export default SynScene;
