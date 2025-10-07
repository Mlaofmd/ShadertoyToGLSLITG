#!/usr/bin/env node
/**
 * Shadertoy -> NotITG GLSL converter
 * - Auto-inserts NotITG-friendly uniforms (imageSize, time, samplerN, etc.)
 * - Replaces Shadertoy idioms (mainImage signature, iTime, iResolution, iChannelN, texture -> texture2D + img2tex, etc.)
 * - Adds main() wrapper calling mainImage(...) as per the conversion guide
 *
 * Usage:
 *   node ShadertoyToGLSLITG.js input.glsl > output.glsl
 *
 * Options (simple):
 *   --version=100|200      (defaults to 100; if you need #version 200, pass 200)
 *
 * Notes / assumptions:
 *  - This script targets NotITG-style GLSL by default and auto-inserts required uniforms.
 *  - Multi-pass or audio-only Shadertoy shaders are not handled fully.
 *  - It takes heuristic/regEx-based transforms — inspect result for edge cases.
 */

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('Usage: node ShadertoyToGLSLITG.js input.glsl [--version=100|200]');
  process.exit(2);
}

const inputPath = argv[0];
const versionArg = argv.find(a => a.startsWith('--version=')) || '--version=100';
const version = versionArg.split('=')[1] || '100';
const raw = fs.readFileSync(inputPath, 'utf8');

let code = raw;

// Helper: simple regex-safe escape for use if needed (not used heavily here)
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 1) Remove leading or trailing BOM/extra whitespace
code = code.replace(/^\uFEFF/, '');

// 2) If the shader already has mainImage signature, we'll keep it but wrap with main().
//    Normalize common mainImage signature variants.
const mainImageRegex = /void\s+mainImage\s*\(\s*(?:out\s+)?vec4\s+([a-zA-Z0-9_]+)\s*,\s*(?:in\s+)?vec2\s+([a-zA-Z0-9_]+)\s*\)/;
const hasMainImage = mainImageRegex.test(code);

// 3) Replace Shadertoy globals with NotITG-friendly names and/or insert fallbacks
// iTime -> time (and add uniform float time;)
code = code.replace(/\biTime\b/g, 'time');

// iResolution -> imageSize usage: replace standalone iResolution with vec3(imageSize, 1.0) if used as vec3
// We'll replace common uses of iResolution.x/y/z or iResolution with vec3(imageSize, 1.0) where appropriate.
// First, replace iResolution.x/y usage to imageSize.x/y when possible:
code = code.replace(/\biResolution\.x\b/g, 'imageSize.x');
code = code.replace(/\biResolution\.y\b/g, 'imageSize.y');
// Replace bare iResolution usage with vec3(imageSize, 1.0)
code = code.replace(/\biResolution\b/g, 'vec3(imageSize, 1.0)');

// iTimeDelta -> fallback const
if (/\biTimeDelta\b/.test(code)) {
  // replace all occurrences
  code = code.replace(/\biTimeDelta\b/g, 'iTimeDeltaFallback');
}

// iFrame -> frame uniform
code = code.replace(/\biFrame\b/g, 'frame');

// iMouse -> const or uniform placeholder (we will insert a uniform by default)
code = code.replace(/\biMouse\b/g, 'iMouse');

// iDate -> fallback const
if (/\biDate\b/.test(code)) {
  code = code.replace(/\biDate\b/g, 'iDateFallback');
}

// iSampleRate and audio-related identifiers: best-effort replace with constants to avoid compile errors
code = code.replace(/\biSampleRate\b/g, '44100.0');

// 4) Handle samplers: iChannel0..iChannel3 -> sampler0..sampler3 (and add uniform declarations later)
for (let i = 0; i <= 3; i++) {
  const src = new RegExp(`\\biChannel${i}\\b`, 'g');
  code = code.replace(src, `sampler${i}`);
}

// 5) Replace texture( sampler, uv ) -> texture2D(sampler, img2tex(uv)) for sampler0..sampler3 and samplerRandom
// We'll hunt for texture( <samplerVar> , <expr> ) occurrences.
// We handle sampler0..sampler3 and samplerRandom specifically to avoid touching other texture calls.
for (const s of ['sampler0', 'sampler1', 'sampler2', 'sampler3', 'samplerRandom']) {
  // pattern: texture\s*\(\s*samplerN\s*,\s*([^)]+)\)
  const pat = new RegExp(`texture\\s*\\(\\s*${s}\\s*,\\s*([^\\)]+)\\)`, 'g');
  code = code.replace(pat, (m, uvExpr) => {
    // trim whitespace
    const uv = uvExpr.trim();
    // wrap with img2tex(...) unless samplerRandom (samplerRandom is already in NotITG space and might be expected to be in same coords)
    if (s === 'samplerRandom') {
      // keep as texture2D(samplerRandom, uv) — NotITG's samplerRandom may already be sized
      return `texture2D(${s}, ${uv})`;
    } else {
      return `texture2D(${s}, img2tex(${uv}))`;
    }
  });
}

// 6) Replace generic texture() (if any left) to texture2D(...) but don't wrap (we can't guess)
code = code.replace(/\btexture\s*\(/g, 'texture2D(');

// 7) fragColor / fragCoord replacement
// Many Shadertoy users refer to fragColor and fragCoord inside mainImage param names; we do NOT replace variable names inside user functions,
// but we will create a wrapper main() that calls mainImage(gl_FragColor, gl_FragCoord.xy).
// For safety, if the user used 'fragColor' or 'fragCoord' identifiers inside code, we leave them alone (they are local).
// So no blind global replacement here.

// 8) If there are iChannelResolution[...] or iChannelTime[...] arrays — these are hard/unsupported; mark with comment
if (/\biChannelResolution\b|\biChannelTime\b/.test(code)) {
  // insert a top-level comment marker
  code = "// NOTE: shader uses iChannelResolution or iChannelTime arrays; those arrays are not representable as simple uniforms in NotITG.\n" + code;
}

// 9) Insert uniform and helper declarations at top (but after any #version if present).
// Compose uniforms according to the guide
let preamble = '';
// Insert version directive if requested and not already present
if (!/^\s*#version/m.test(code)) {
  if (version && version !== '100') {
    preamble += `#version ${version}\n`;
  }
}

// default precision (helpful for WebGL/GLSL ES targets)
preamble += `precision mediump float;\n\n`;

// NotITG uniforms / fallbacks (auto-insert)
preamble += `// NotITG auto-inserted uniforms and fallbacks (generated)\n`;
preamble += `uniform vec2 imageSize; // viewport size (x = width, y = height)\n`;
preamble += `uniform float time; // seconds\n`;
preamble += `uniform float frame; // current frame (optional)\n`;
preamble += `uniform vec4 iMouse; // optional mouse vec4\n`;
// add samplers
preamble += `uniform sampler2D sampler0;\n`;
preamble += `uniform sampler2D sampler1;\n`;
preamble += `uniform sampler2D sampler2;\n`;
preamble += `uniform sampler2D sampler3;\n`;
preamble += `uniform sampler2D samplerRandom; // built-in random/noise sampler in NotITG (if available)\n`;
// texture helper sizes used by img2tex
preamble += `uniform vec2 textureSize; // size of the source texture used for img2tex transformations (set by mod)\n\n`;

// fallback constants for things NotITG doesn't provide automatically
if (/\biTimeDelta\b/.test(raw)) {
  preamble += `// iTimeDelta fallback (NotITG usually doesn't provide). Try setting a real value if needed.\nconst float iTimeDeltaFallback = 0.0;\n`;
}
if (/\biDate\b/.test(raw)) {
  preamble += `// iDate fallback (not generally available)\nconst vec4 iDateFallback = vec4(0.0);\n`;
}
preamble += `\n`;

// Add img2tex helper function (per guide)
preamble += `// Converts normalized UVs (0..1) suitable for Shadertoy to texture coords used in NotITG.
// It uses textureSize (source texture logical size) and imageSize (viewport size).
vec2 img2tex(vec2 v) {
    // Avoid divide-by-zero in degenerate cases
    vec2 ts = max(textureSize, vec2(1.0, 1.0));
    vec2 im = max(imageSize, vec2(1.0, 1.0));
    return v / ts * im;
}\n\n`;

// If the original code already has a preamble or precision, don't duplicate excessively — user can remove duplicates.
// Now we need to place the preamble before the rest of code. But if the file already had #version at top, insert after it.
if (/^\s*#version/m.test(code)) {
  // place preamble after the first #version line
  code = code.replace(/^\s*#version[^\n]*\n/, (m) => m + preamble);
} else {
  code = preamble + code;
}

// 10) Ensure a main() wrapper exists that calls mainImage(gl_FragColor, gl_FragCoord.xy)
// If the shader defines mainImage with arbitrary parameter names we still call it by position.
// If there's no mainImage, we will add an empty main() if main() also doesn't exist (so it's still valid GLSL).
const hasMain = /\bvoid\s+main\s*\(/.test(code);
if (hasMainImage) {
  // If main() already exists, don't add a duplicate. Instead, if main exists we will not wrap. 
  // But most shadertoy shaders don't define main(), they define mainImage.
  if (!hasMain) {
    // Build wrapper main
    // find the actual name used for fragColor/fragCoord in mainImage signature so we can call it by position
    const sigMatch = code.match(mainImageRegex);
    let fragColorName = 'fragColor';
    let fragCoordName = 'fragCoord';
    if (sigMatch && sigMatch.length >= 3) {
      fragColorName = sigMatch[1];
      fragCoordName = sigMatch[2];
    }
    // We'll add a main() that calls mainImage(gl_FragColor, gl_FragCoord.xy);
    const wrapper = `\nvoid main() {\n    // Call original Shadertoy-style entrypoint\n    // mainImage(out vec4 ${fragColorName}, in vec2 ${fragCoordName})\n    mainImage(gl_FragColor, gl_FragCoord.xy);\n}\n`;
    code = code + '\n' + wrapper;
  } else {
    // main() exists; attempt a safer approach: if main() is empty or small, we can replace it, but to avoid complexity, add a comment
    code = code + '\n// NOTE: original shader already defines main(); make sure it calls mainImage(...) or adapt as needed.\n';
  }
} else {
  // No mainImage and no main: create minimal main that does nothing (to avoid compile error)
  if (!hasMain) {
    code = code + '\nvoid main() { gl_FragColor = vec4(0.0); }\n';
  }
}

// 11) Post-process: tidy up multiple newlines
code = code.replace(/\n{3,}/g, '\n\n');

// 12) Output result
process.stdout.write(code);
