/**
 * Custom post filters for the lit renderer. WebGL only — the lab and the game
 * both force `preference: 'webgl'`, so a GlProgram alone is enough and we skip
 * writing every shader twice in WGSL.
 *
 * One filter does the whole grade + lens pass. Splitting exposure, contrast,
 * saturation, tint, vignette, chroma, grain and scanlines into eight filters
 * would mean eight full-screen round trips for arithmetic that fits in one.
 */

import { Filter, GlProgram } from 'pixi.js';

/** Pixi v8's stock filter vertex shader (GLSL). */
const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

const GRADE_FRAG = /* glsl */ `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;

uniform vec2 uDimensions;   // filter area in px — gives us true 0..1 screen uv
uniform vec4 uTone;         // exposure, contrast, saturation, gamma
uniform vec4 uLift;         // shadow tint rgb, amount
uniform vec4 uGain;         // highlight tint rgb, amount
uniform vec4 uLens;         // vignette, vignette softness, chroma px, grain
uniform vec4 uMisc;         // scanline, time, enabled, unused

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main(void)
{
    vec2 uv = (vTextureCoord * uInputSize.xy) / uDimensions;
    vec2 centered = uv - 0.5;
    float r2 = dot(centered, centered);

    // Chromatic aberration: lens dispersion grows with distance from centre, so
    // the split has to be radial. A constant offset reads as a broken TV, not a lens.
    vec3 col;
    float ca = uLens.z;
    if (ca > 0.001) {
        vec2 dir = centered * ca * 0.004 * (0.35 + r2);
        col.r = texture(uTexture, vTextureCoord + dir * uInputSize.zw * uDimensions).r;
        col.g = texture(uTexture, vTextureCoord).g;
        col.b = texture(uTexture, vTextureCoord - dir * uInputSize.zw * uDimensions).b;
    } else {
        col = texture(uTexture, vTextureCoord).rgb;
    }

    if (uMisc.z > 0.5) {
        col *= uTone.x;                                   // exposure, in linear-ish space

        // Lift/gain before contrast: tinting the shadows and then stretching
        // contrast keeps the tint visible. The other order washes it out.
        float l = dot(col, LUMA);
        col = mix(col, uLift.rgb, uLift.w * (1.0 - smoothstep(0.0, 0.55, l)));
        col = mix(col, col * uGain.rgb, uGain.w * smoothstep(0.25, 1.0, l));

        col = (col - 0.5) * uTone.y + 0.5;                // contrast about mid-grey
        col = max(col, 0.0);
        float g = dot(col, LUMA);
        col = mix(vec3(g), col, uTone.z);                 // saturation
        col = pow(col, vec3(1.0 / max(uTone.w, 0.05)));   // gamma
    }

    // Vignette. Softness controls how far in the falloff starts; a hard edge
    // reads as a mask, a soft one reads as glass.
    float v = uLens.x;
    if (v > 0.001) {
        float d = length(centered) * 1.4142;
        col *= 1.0 - v * smoothstep(1.0 - uLens.y, 1.0, d);
    }

    // Scanlines at the LOGICAL resolution, not the display one, or they moire.
    float sl = uMisc.x;
    if (sl > 0.001) {
        float line = 0.5 + 0.5 * cos(uv.y * uDimensions.y * 3.14159265);
        col *= 1.0 - sl * line;
    }

    // Grain last, and additive rather than multiplicative — film grain lives in
    // the shadows, and multiplying kills it exactly where it should be strongest.
    float gr = uLens.w;
    if (gr > 0.001) {
        float n = hash12(uv * uDimensions + uMisc.y * 91.7);
        col += (n - 0.5) * gr;
    }

    finalColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export interface GradeUniforms {
  uDimensions: Float32Array;
  uTone: Float32Array;
  uLift: Float32Array;
  uGain: Float32Array;
  uLens: Float32Array;
  uMisc: Float32Array;
}

/** Exposure → contrast → saturation → gamma → lift/gain → vignette → CA → grain. */
export class GradeFilter extends Filter {
  readonly u: GradeUniforms;

  constructor(width: number, height: number) {
    const glProgram = GlProgram.from({
      vertex: VERT,
      fragment: GRADE_FRAG,
      name: 'lit-grade',
    });
    super({
      glProgram,
      resources: {
        gradeUniforms: {
          uDimensions: { value: new Float32Array([width, height]), type: 'vec2<f32>' },
          uTone: { value: new Float32Array([1, 1, 1, 1]), type: 'vec4<f32>' },
          uLift: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
          uGain: { value: new Float32Array([1, 1, 1, 0]), type: 'vec4<f32>' },
          uLens: { value: new Float32Array([0, 0.5, 0, 0]), type: 'vec4<f32>' },
          uMisc: { value: new Float32Array([0, 0, 1, 0]), type: 'vec4<f32>' },
        },
      },
    });
    this.padding = 0;
    this.u = (this.resources.gradeUniforms as { uniforms: GradeUniforms }).uniforms;
  }
}

// ---------------------------------------------------------------- lightmap

const LIGHTMAP_FRAG = /* glsl */ `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uMapTexture;
uniform vec4 uInputSize;
uniform vec2 uDimensions;
uniform vec2 uParams;   // spill, unused

void main(void)
{
    vec4 diffuse = texture(uTexture, vTextureCoord);
    vec2 lightCoord = (vTextureCoord * uInputSize.xy) / uDimensions;
    vec3 light = texture(uMapTexture, lightCoord).rgb;

    // Straight multiply is physically the right answer and visually a dead one:
    // a surface with no albedo in a channel can never take that light's hue. The
    // spill term adds a fraction of the light on top, weighted by how bright the
    // surface already is, so a grey desk under a sodium lamp actually goes warm.
    vec3 col = diffuse.rgb * light;
    float m = dot(diffuse.rgb, vec3(0.2126, 0.7152, 0.0722));
    col += light * m * uParams.x;

    finalColor = vec4(col, diffuse.a);
}
`;

/** Multiplies the scene by a lightmap texture, plus a tunable colour-spill term. */
export class LightmapFilter extends Filter {
  readonly u: { uDimensions: Float32Array; uParams: Float32Array };

  constructor(lightMap: import('pixi.js').Texture, width: number, height: number) {
    const glProgram = GlProgram.from({
      vertex: VERT,
      fragment: LIGHTMAP_FRAG,
      name: 'lit-lightmap',
    });
    super({
      glProgram,
      resources: {
        lightmapUniforms: {
          uDimensions: { value: new Float32Array([width, height]), type: 'vec2<f32>' },
          uParams: { value: new Float32Array([0.35, 0]), type: 'vec2<f32>' },
        },
        uMapTexture: lightMap.source,
        uMapSampler: lightMap.source.style,
      },
    });
    this.padding = 0;
    this.u = (this.resources.lightmapUniforms as {
      uniforms: { uDimensions: Float32Array; uParams: Float32Array };
    }).uniforms;
  }
}
