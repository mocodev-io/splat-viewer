// Replacement for the engine's `composePS` chunk (PlayCanvas 2.23, GLSL / WebGL2).
//
// The engine's own compose pass applies bloom, DoF, SSAO, grading, LUT, vignette
// etc. This copy keeps every one of those #ifdef blocks exactly where the engine
// has them and adds the "sv_" stages around them:
//
//   screen warps (crt curve, lens distortion, gate weave, glitch, pixelate)
//   -> scene sample with chromatic aberration (kuwahara, lens DoF, motion blur,
//      glitch colour split)
//   -> engine: sharpen (in focus only), dof ("fast" mode only), ssao, bloom
//   -> hdr extras (halation, anamorphic streaks, lens dirt, exposure, flicker, light leak)
//   -> engine: colour enhance, grading, tonemap, LUT, vignette
//   -> display stylize (posterize, looks, paper, outline)
//   -> gamma -> grain, crt mask, letterbox
//
// Every sv_ effect is switched by its uniform being > 0, so toggling effects
// never triggers a shader recompile.
//
// The engine version is pinned in package.json; when bumping it, diff this
// against node_modules/playcanvas/build/playcanvas/src/scene/shader-lib/glsl/
// chunks/render-pass/frag/compose/compose.js.

export const composePS = /* glsl */ `
    #include "tonemappingPS"
    #include "gammaPS"
    varying vec2 uv0;
    uniform sampler2D sceneTexture;
    uniform vec2 sceneTextureInvRes;
    uniform float composeTargetFlipY;
    #include "composeBloomPS"
    #include "composeDofPS"
    #include "composeSsaoPS"
    #include "composeGradingPS"
    #include "composeColorEnhancePS"
    #include "composeVignettePS"
    #include "composeFringingPS"
    #include "composeCasPS"
    #include "composeColorLutPS"
    #include "composeDeclarationsPS"

    uniform float sv_time;
    uniform vec2 sv_res;
    uniform float sv_exposure;
    uniform float sv_flicker;

    uniform float sv_distortion;
    uniform float sv_crt;
    uniform float sv_gateWeave;
    uniform float sv_glitch;
    uniform float sv_pixelate;
    uniform float sv_fringing;         // lateral chromatic aberration strength

    uniform float sv_motionBlur;
    uniform mat4 sv_reproject;
    uniform vec3 sv_camMotion;
    uniform float sv_kuwahara;

    // depth of field: 0 off, 1 engine ("fast"), 2 thin lens
    uniform int sv_dofMode;
    uniform highp sampler2D uSceneDepthMap;
    uniform int sv_depthMode;          // 0 unavailable, 1 linear, 2 reciprocal (splat scene depth)
    uniform float sv_far;
    uniform float sv_focus;            // focus distance, world units
    uniform float sv_aperture;         // blur radius at infinity, scene pixels
    uniform float sv_dofMaxRadius;     // largest blur radius, scene pixels
    uniform float sv_nearBlur;         // 1 = blur in front of the focus plane too
    uniform int sv_bokeh;              // 0 round, 1 hexagon, 2 octagon, 3 anamorphic, 4 swirl
    uniform float sv_dofSeed;          // 0 = fixed pattern; changes per frame when TAA can average it

    uniform float sv_halation;
    uniform float sv_anamorphic;
    uniform vec3 sv_anamorphicTint;
    uniform float sv_dirt;
    uniform float sv_lightLeak;

    uniform float sv_posterize;
    uniform int sv_look;
    uniform float sv_lookMix;
    uniform float sv_cell;
    uniform vec3 sv_duoDark;
    uniform vec3 sv_duoLight;
    uniform float sv_paper;
    uniform float sv_outline;
    uniform vec3 sv_outlineColor;

    uniform float sv_grain;
    uniform float sv_grainSize;
    uniform float sv_grainAnimated;
    uniform float sv_letterbox;

    // ---------------------------------------------------------------- helpers

    float svHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    float svNoise1(float x) {
        float i = floor(x);
        float f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(svHash(vec2(i, 0.37)), svHash(vec2(i + 1.0, 0.37)), f);
    }

    float svNoise2(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = svHash(i);
        float b = svHash(i + vec2(1.0, 0.0));
        float c = svHash(i + vec2(0.0, 1.0));
        float d = svHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // round specks scattered on a grid, for lens dirt
    float svSpecks(vec2 p, float density, float seed) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 c = vec2(svHash(i + seed), svHash(i + seed + 3.1)) * 0.6 + 0.2;
        float r = 0.08 + 0.22 * svHash(i + seed + 7.7);
        float on = step(1.0 - density, svHash(i + seed + 11.3));
        return on * smoothstep(r, 0.0, length(f - c)) * (0.4 + 0.6 * svHash(i + seed + 5.5));
    }

    float svLuma(vec3 c) {
        return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    vec3 svSample(vec2 uv) {
        return texture2DLod(sceneTexture, uv, 0.0).rgb;
    }

    // Lateral chromatic aberration: red lands a bit further out from the
    // centre, blue a bit further in. Used for every sample the DoF and motion
    // blur gather, so the colour fringes blur along with the image.
    vec3 svSampleCA(vec2 uv) {
        if (sv_fringing <= 0.0) return svSample(uv);
        vec2 c = uv - 0.5;
        vec2 ca = vec2(c.x * sv_res.x / sv_res.y, c.y);
        vec2 off = c * dot(ca, ca) * sv_fringing;
        return vec3(svSample(uv + off).r, svSample(uv).g, svSample(uv - off).b);
    }

    // how many pixels the lens DoF blurred the current pixel; keeps sharpening
    // out of the blurred areas
    float svDofBlur = 0.0;

    // Tonemapped sample, for effects that look at neighbouring cells after tonemapping.
    vec3 svDisplay(vec2 uv) {
        return toneMap(max(vec3(0.0), svSample(uv) * exp2(sv_exposure)));
    }

    // ---------------------------------------------------------- screen warps

    vec2 svWarp(vec2 uv, out float outside) {
        outside = 0.0;
        float aspect = sv_res.x / sv_res.y;

        // CRT tube curvature: not normalised, the corners fall off the tube
        if (sv_crt > 0.0) {
            vec2 c = uv - 0.5;
            vec2 ca = vec2(c.x * aspect, c.y);
            c *= 1.0 + sv_crt * 0.18 * dot(ca, ca);
            uv = c + 0.5;
            if (any(greaterThan(abs(c), vec2(0.5)))) outside = 1.0;
        }

        // lens distortion, normalised so the frame stays filled
        if (sv_distortion != 0.0) {
            vec2 c = uv - 0.5;
            vec2 ca = vec2(c.x * aspect, c.y);
            float r2 = dot(ca, ca);
            float rMax2 = 0.25 * aspect * aspect + 0.25;
            uv = c * (1.0 + sv_distortion * r2) / (1.0 + sv_distortion * rMax2) + 0.5;
        }

        // gate weave: the film frame wobbling in the projector gate
        if (sv_gateWeave > 0.0) {
            float t = floor(sv_time * 24.0) / 24.0;
            uv += (vec2(svNoise1(t * 3.1), svNoise1(t * 2.3 + 17.0)) - 0.5) * 0.006 * sv_gateWeave;
        }

        // glitch: bands of the image jumping sideways, plus line jitter
        if (sv_glitch > 0.0) {
            float t = floor(sv_time * 15.0);
            float band = floor(uv.y * (8.0 + 24.0 * svHash(vec2(t, 1.0))));
            float hit = step(1.0 - sv_glitch * 0.35, svHash(vec2(band, t)));
            uv.x += (svHash(vec2(band, t + 0.5)) - 0.5) * 0.12 * sv_glitch * hit;
            float row = floor(uv.y * sv_res.y);
            uv.x += (svHash(vec2(row, floor(sv_time * 60.0))) - 0.5) * 0.0025 * sv_glitch;
        }

        // pixelate in screen pixels
        if (sv_pixelate > 0.0) {
            vec2 cell = vec2(sv_pixelate) / sv_res;
            uv = (floor(uv / cell) + 0.5) * cell;
        }

        return uv;
    }

    // --------------------------------------------------------- scene sample

    // Per-pixel screen motion of the last frame. Camera rotation is exact
    // (reprojection does not need depth for it); translation is approximated
    // with the focus distance as the scene depth.
    vec2 svVelocity(vec2 uv) {
        vec4 prev = sv_reproject * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
        vec2 v = vec2(0.0);
        if (prev.w > 0.0) {
            v = uv - ((prev.xy / prev.w) * 0.5 + 0.5);
        }
        v += (uv - 0.5) * sv_camMotion.z + sv_camMotion.xy;
        v *= sv_motionBlur;
        float len = length(v);
        return len > 0.08 ? v * (0.08 / len) : v;
    }

    // Kuwahara: the flattest of four quadrants wins, which reads as brush strokes.
    vec3 svKuwahara(vec2 uv, float radius) {
        vec2 px = sceneTextureInvRes * (radius / 4.0);
        vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
        vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
        for (int j = -4; j <= 4; j++) {
            for (int i = -4; i <= 4; i++) {
                vec3 c = svSample(uv + vec2(float(i), float(j)) * px);
                c = c / (1.0 + c);
                vec3 cc = c * c;
                if (i <= 0 && j <= 0) { m0 += c; s0 += cc; }
                if (i >= 0 && j <= 0) { m1 += c; s1 += cc; }
                if (i <= 0 && j >= 0) { m2 += c; s2 += cc; }
                if (i >= 0 && j >= 0) { m3 += c; s3 += cc; }
            }
        }
        m0 /= 25.0; m1 /= 25.0; m2 /= 25.0; m3 /= 25.0;
        vec3 v0 = abs(s0 / 25.0 - m0 * m0);
        vec3 v1 = abs(s1 / 25.0 - m1 * m1);
        vec3 v2 = abs(s2 / 25.0 - m2 * m2);
        vec3 v3 = abs(s3 / 25.0 - m3 * m3);
        float bestVar = v0.r + v0.g + v0.b;
        vec3 best = m0;
        float v;
        v = v1.r + v1.g + v1.b; if (v < bestVar) { bestVar = v; best = m1; }
        v = v2.r + v2.g + v2.b; if (v < bestVar) { bestVar = v; best = m2; }
        v = v3.r + v3.g + v3.b; if (v < bestVar) { bestVar = v; best = m3; }
        return best / max(1.0 - best, vec3(0.001));
    }

    // ------------------------------------------------------- lens DoF

    float svDepth(vec2 uv) {
        float v = texture2DLod(uSceneDepthMap, uv, 0.0).r;
        if (sv_depthMode == 2) return v > 0.0 ? 1.0 / v : sv_far;
        return v;
    }

    // Thin lens: the blur circle grows with |1/focus - 1/depth|. Behind the
    // focus plane it levels off towards the aperture size, in front of it it
    // grows fast, like a real lens.
    float svCoc(float depth) {
        float c = (1.0 - sv_focus / max(depth, 1e-4)) * sv_aperture;
        if (c < 0.0) c *= sv_nearBlur;
        return min(abs(c), sv_dofMaxRadius);
    }

    // Shapes the sample pattern: a disc becomes polygon, oval or swirl.
    vec2 svBokehOffset(float angle, float radius, vec2 uv) {
        vec2 dir = vec2(cos(angle), sin(angle));
        if (sv_bokeh == 1 || sv_bokeh == 2) {
            float blades = sv_bokeh == 1 ? 6.0 : 8.0;
            float seg = 6.2831853 / blades;
            float a = mod(angle + 0.3, seg) - seg * 0.5;
            dir *= cos(seg * 0.5) / cos(a);
        } else if (sv_bokeh == 3) {
            dir.x *= 0.5;                                  // anamorphic: tall ovals
        } else if (sv_bokeh == 4) {
            // swirl (vintage Petzval / Helios): discs squash into cat's eyes
            // towards the frame edge, lined up around the centre
            vec2 c = (uv - 0.5) * vec2(sv_res.x / sv_res.y, 1.0);
            float d = length(c);
            if (d > 1e-3) {
                vec2 radial = c / d;
                vec2 tangent = vec2(-radial.y, radial.x);
                float squash = 1.0 - clamp(d * 1.1, 0.0, 0.75);
                dir = radial * dot(dir, radial) * squash + tangent * dot(dir, tangent);
            }
        }
        return dir * radius;
    }

    // Single-pass scatter-as-gather on a golden-angle spiral: a sample counts
    // when its own blur circle reaches this pixel, so blurred foreground spills
    // over sharp background, while background behind a sharp object is held
    // back (no halos).
    vec3 svLensDof(vec2 uv, vec3 base) {
        float centerDepth = svDepth(uv);
        float centerSize = svCoc(centerDepth);
        svDofBlur = centerSize;
        float maxR = sv_dofMaxRadius;
        vec3 color = base;
        float total = 1.0;
        // ~128 samples whatever the size; each pixel turns the spiral by its own
        // angle, so small highlights read as discs instead of showing the
        // sample pattern. Colour is read between texels (a free 2x2 average),
        // which gives tiny highlights more chance to be picked up.
        float radScale = max(maxR * maxR / 256.0, 0.2);
        float radius = radScale;
        float angle = svHash(gl_FragCoord.xy + sv_dofSeed) * 6.2831853;
        vec2 between = 0.5 * sceneTextureInvRes;
        for (int i = 0; i < 260; i++) {
            if (radius >= maxR) break;
            vec2 tc = uv + svBokehOffset(angle, radius, uv) * sceneTextureInvRes;
            vec3 sampleColor = svSampleCA(tc + between);
            float sampleDepth = svDepth(tc);
            float sampleSize = svCoc(sampleDepth);
            if (sampleDepth > centerDepth) sampleSize = min(sampleSize, centerSize * 2.0);
            float m = smoothstep(radius - 0.5, radius + 0.5, sampleSize);
            color += mix(color / total, sampleColor, m);
            total += 1.0;
            angle += 2.39996323;
            radius += radScale / radius;
        }
        return color / total;
    }

    vec3 svScene(vec2 uv, vec3 base) {
        vec3 col = base;

        if (sv_kuwahara > 0.0) {
            col = svKuwahara(uv, sv_kuwahara);
        } else {
            if (sv_dofMode == 2 && sv_depthMode > 0 && sv_dofMaxRadius > 0.5) {
                col = svLensDof(uv, base);
            }
            if (sv_motionBlur > 0.0) {
                vec2 v = svVelocity(uv);
                if (dot(v, v) > 1e-9) {
                    vec3 blurred = vec3(0.0);
                    float jitter = svHash(gl_FragCoord.xy + fract(sv_time) * 61.0) - 0.5;
                    for (int i = 0; i < 12; i++) {
                        float t = (float(i) + 0.5 + jitter) / 12.0 - 0.5;
                        blurred += svSampleCA(uv - v * t);
                    }
                    // add the streaks on top of whatever DoF made of this pixel
                    col = max(col + blurred / 12.0 - base, vec3(0.0));
                }
            }
        }

        if (sv_glitch > 0.0) {
            float t = floor(sv_time * 15.0);
            float burst = step(1.0 - sv_glitch * 0.5, svHash(vec2(t, 7.0)));
            vec2 off = vec2(0.0015 + 0.015 * burst, 0.0) * sv_glitch;
            col.r = svSample(uv + off).r;
            col.b = svSample(uv - off).b;
        }

        return col;
    }

    // ------------------------------------------------------- display stylize

    float svEdge(vec2 uv) {
        vec2 px = sceneTextureInvRes;
        float tl = log(1.0 + 4.0 * svLuma(svSample(uv + vec2(-px.x,  px.y))));
        float t  = log(1.0 + 4.0 * svLuma(svSample(uv + vec2( 0.0,   px.y))));
        float tr = log(1.0 + 4.0 * svLuma(svSample(uv + vec2( px.x,  px.y))));
        float l  = log(1.0 + 4.0 * svLuma(svSample(uv + vec2(-px.x,  0.0))));
        float r  = log(1.0 + 4.0 * svLuma(svSample(uv + vec2( px.x,  0.0))));
        float bl = log(1.0 + 4.0 * svLuma(svSample(uv + vec2(-px.x, -px.y))));
        float b  = log(1.0 + 4.0 * svLuma(svSample(uv + vec2( 0.0,  -px.y))));
        float br = log(1.0 + 4.0 * svLuma(svSample(uv + vec2( px.x, -px.y))));
        float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
        float gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
        return smoothstep(0.12, 0.45, sqrt(gx * gx + gy * gy));
    }

    vec3 svThermal(float t) {
        t = clamp(t, 0.0, 1.0) * 5.0;
        vec3 c0 = vec3(0.0, 0.0, 0.02);
        vec3 c1 = vec3(0.12, 0.0, 0.45);
        vec3 c2 = vec3(0.65, 0.0, 0.55);
        vec3 c3 = vec3(1.0, 0.25, 0.0);
        vec3 c4 = vec3(1.0, 0.8, 0.05);
        vec3 c5 = vec3(1.0, 1.0, 0.95);
        if (t < 1.0) return mix(c0, c1, t);
        if (t < 2.0) return mix(c1, c2, t - 1.0);
        if (t < 3.0) return mix(c2, c3, t - 2.0);
        if (t < 4.0) return mix(c3, c4, t - 3.0);
        return mix(c4, c5, t - 4.0);
    }

    // 5x5 bitmap glyphs, darkest to brightest: . : * o & 8 @ #
    float svGlyph(float level, vec2 p) {
        int n = 4096;
        if (level > 0.2) n = 65600;
        if (level > 0.3) n = 332772;
        if (level > 0.4) n = 15255086;
        if (level > 0.5) n = 23385164;
        if (level > 0.6) n = 15252014;
        if (level > 0.7) n = 13199452;
        if (level > 0.8) n = 11512810;
        if (level < 0.08) return 0.0;
        p = floor(p * vec2(-4.0, 4.0) + 2.5);
        if (p.x < 0.0 || p.x > 4.0 || p.y < 0.0 || p.y > 4.0) return 0.0;
        int a = int(p.x + 5.0 * p.y);
        return float((n >> a) & 1);
    }

    // result is linear, after tonemapping
    vec3 svLook(vec3 result) {
        float aspect = sv_res.x / sv_res.y;
        vec3 perceptual = pow(max(result, vec3(0.0)), vec3(1.0 / 2.2));
        float lum = svLuma(perceptual);

        if (sv_look == 1) {                                   // duotone
            return mix(sv_duoDark, sv_duoLight, smoothstep(0.0, 1.0, lum));
        }
        if (sv_look == 2) {                                   // thermal
            return pow(svThermal(lum), vec3(2.2));
        }
        if (sv_look == 3) {                                   // night vision
            vec3 g = vec3(0.25, 1.0, 0.3) * pow(lum, 0.75) * 1.2;
            return pow(g, vec3(2.2));
        }
        if (sv_look == 4) {                                   // halftone
            float s = 0.70710678;
            mat2 rot = mat2(s, -s, s, s);
            vec2 p = rot * gl_FragCoord.xy;
            vec2 center = (floor(p / sv_cell) + 0.5) * sv_cell;
            vec2 centerPx = transpose(rot) * center;
            vec3 cellCol = pow(svDisplay(centerPx / sv_res), vec3(1.0 / 2.2));
            float cellLum = svLuma(cellCol);
            float radius = sqrt(1.0 - cellLum) * sv_cell * 0.72;
            float ink = 1.0 - smoothstep(radius - 0.75, radius + 0.75, length(p - center));
            vec3 paper = vec3(0.96, 0.94, 0.89);
            vec3 inkCol = cellCol * 0.55;
            return pow(mix(paper, inkCol, ink), vec3(2.2));
        }
        if (sv_look == 5) {                                   // ascii
            vec2 cellIdx = floor(gl_FragCoord.xy / sv_cell);
            vec2 centerUv = (cellIdx + 0.5) * sv_cell / sv_res;
            vec3 cellCol = svDisplay(centerUv);
            float cellLum = svLuma(pow(cellCol, vec3(1.0 / 2.2)));
            vec2 p = fract(gl_FragCoord.xy / sv_cell) * 2.0 - 1.0;
            float on = svGlyph(cellLum, p * 1.1);
            return cellCol * on * 1.6;
        }
        return result;
    }

    // ------------------------------------------------------------------ main

    void main() {
        #include "composeMainStartPS"
        vec2 screenUv = uv0;
        vec2 baseUv = vec2(uv0.x, mix(uv0.y, 1.0 - uv0.y, composeTargetFlipY));
        float outside;
        vec2 uv = svWarp(baseUv, outside);
        vec4 scene = texture2DLod(sceneTexture, uv, 0.0);
        vec3 result = svScene(uv, svSampleCA(uv));
        #ifdef CAS
            // the engine's sharpen reads the unblurred scene, so it would put
            // detail back into what the DoF just softened
            result = mix(applyCas(result, uv, sharpness), result, clamp(svDofBlur / 1.5, 0.0, 1.0));
        #endif
        #ifdef DOF
            if (sv_dofMode == 1) result = applyDof(result, uv);
        #endif
        #ifdef SSAO_TEXTURE
            result = applySsao(result, uv);
        #endif
        #ifdef BLOOM
            result = applyBloom(result, uv);
            if (sv_halation > 0.0) {
                result += dBloom * vec3(1.0, 0.22, 0.06) * sv_halation * 0.6;
            }
            if (sv_anamorphic > 0.0) {
                vec3 streak = vec3(0.0);
                for (int i = -10; i <= 10; i++) {
                    float x = float(i) / 10.0;
                    streak += texture2DLod(bloomTexture, uv + vec2(x * 0.3, 0.0), 0.0).rgb * exp(-abs(x) * 4.0);
                }
                streak = max(streak / 4.0 - 0.6, vec3(0.0));
                result += streak * sv_anamorphicTint * sv_anamorphic;
            }
            if (sv_dirt > 0.0) {
                vec2 a = vec2(sv_res.x / sv_res.y, 1.0);
                vec2 p = uv * a;
                float smudge = smoothstep(0.35, 0.9, svNoise2(p * 2.5 + 3.7)) * 0.35;
                float dirt = smudge
                           + svSpecks(p * 6.0, 0.35, 1.0)
                           + svSpecks(p * 14.0, 0.25, 17.0) * 0.7
                           + svSpecks(p * 33.0, 0.2, 41.0) * 0.5;
                result += dBloom * dirt * sv_dirt;
            }
        #endif

        float flicker = 1.0 + (svNoise1(sv_time * 18.0) - 0.5) * sv_flicker * 0.7;
        result *= exp2(sv_exposure) * flicker;

        if (sv_lightLeak > 0.0) {
            float aspect = sv_res.x / sv_res.y;
            float t = sv_time * 0.07;
            vec2 a = vec2(aspect, 1.0);
            vec2 p1 = vec2(-0.1 + 0.35 * svNoise1(t * 3.0), 0.2 + 0.6 * svNoise1(t * 2.0 + 5.0));
            vec2 p2 = vec2(1.1 - 0.35 * svNoise1(t * 2.5 + 9.0), 0.8 - 0.6 * svNoise1(t * 1.7 + 2.0));
            float l1 = exp(-dot((uv - p1) * a, (uv - p1) * a) * 3.0);
            float l2 = exp(-dot((uv - p2) * a, (uv - p2) * a) * 4.0);
            float pulse = 0.55 + 0.45 * svNoise1(sv_time * 0.6 + 3.0);
            result += (l1 * vec3(1.0, 0.35, 0.08) + l2 * vec3(1.0, 0.12, 0.35)) * sv_lightLeak * pulse * 1.5;
        }

        #ifdef COLOR_ENHANCE
            result = applyColorEnhance(result);
        #endif
        #ifdef GRADING
            result = applyGrading(result);
        #endif
        result = toneMap(max(vec3(0.0), result));
        #ifdef COLOR_LUT
            result = applyColorLUT(result);
        #endif
        #ifdef VIGNETTE
            result = applyVignette(result, uv);
        #endif

        if (sv_posterize > 0.0) {
            vec3 p = pow(max(result, vec3(0.0)), vec3(1.0 / 2.2));
            p = floor(p * sv_posterize + 0.5) / sv_posterize;
            result = pow(p, vec3(2.2));
        }
        if (sv_look > 0) {
            result = mix(result, svLook(result), sv_lookMix);
        }
        if (sv_paper > 0.0) {
            result = mix(result, vec3(0.83, 0.8, 0.73), sv_paper);
        }
        if (sv_outline > 0.0) {
            result = mix(result, sv_outlineColor, svEdge(uv) * sv_outline);
        }

        #include "composeMainEndPS"
        #ifdef DEBUG_COMPOSE
            #if DEBUG_COMPOSE == scene
                result = scene.rgb;
            #elif defined(BLOOM) && DEBUG_COMPOSE == bloom
                result = dBloom * bloomIntensity;
            #elif defined(DOF) && DEBUG_COMPOSE == dofcoc
                result = vec3(dCoc, 0.0);
            #elif defined(DOF) && DEBUG_COMPOSE == dofblur
                result = dBlur;
            #elif defined(SSAO_TEXTURE) && DEBUG_COMPOSE == ssao
                result = vec3(dSsao);
            #elif defined(VIGNETTE) && DEBUG_COMPOSE == vignette
                result = vec3(dVignette);
            #endif
        #endif
        result = gammaCorrectOutput(result);

        // ---- display-space finishing (after gamma)

        if (sv_grain > 0.0) {
            vec2 gp = floor(gl_FragCoord.xy / sv_grainSize);
            vec2 seed = vec2(fract(sv_time * 7.31) * 113.0, fract(sv_time * 3.17) * 71.0) * sv_grainAnimated;
            float n = (svHash(gp + seed) + svHash(gp + seed + 19.19) + svHash(gp - seed + 7.7)) / 3.0 - 0.5;
            float lum = svLuma(result);
            float weight = 1.0 - 0.6 * lum * lum;
            result += n * sv_grain * 2.0 * weight;
        }

        if (sv_crt > 0.0) {
            float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 2.0943951);
            result *= mix(1.0, 0.65 + 0.35 * scan, sv_crt);
            int column = int(mod(gl_FragCoord.x, 3.0));
            vec3 mask = column == 0 ? vec3(1.0, 0.7, 0.7) : column == 1 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0);
            result *= mix(vec3(1.0), mask * 1.2, sv_crt * 0.7);
        }

        if (sv_letterbox > 0.0) {
            float aspect = sv_res.x / sv_res.y;
            if (sv_letterbox > aspect) {
                if (abs(screenUv.y - 0.5) > 0.5 * aspect / sv_letterbox) result = vec3(0.0);
            } else {
                if (abs(screenUv.x - 0.5) > 0.5 * sv_letterbox / aspect) result = vec3(0.0);
            }
        }

        if (outside > 0.0) result = vec3(0.0);

        gl_FragColor = vec4(result, scene.a);
    }
`;
