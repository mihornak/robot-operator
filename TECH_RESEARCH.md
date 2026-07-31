# Tech stack research (agent report, 2026-07-31)

Preserved verbatim from the research agent. Decisions derived from it live in `GAME_SPEC.md` §10.

---

**Headline finding: the voice mechanic cannot work inside a Discord Activity today.** Discord's Activity iframe is not granted the `microphone` permission policy, so `getUserMedia` fails — which kills Web Speech API *and* whisper-wasm equally, in every engine. Source: discord/embedded-app-sdk issue #363, "[Feature Request] Secure, proxied microphone access for frequency analysis in Activities", opened 2026-04-14, still OPEN, no Discord staff response. Cross-origin iframes need an explicit `allow="microphone"` from the parent (MDN Permissions-Policy/microphone: default allowlist is `self`), and Discord does not set it. Engine-independent; must drive the architecture.

## 1. Primary recommendation: PixiJS v8 + hand-rolled TS game loop

PixiJS 8.19.0 (2026-06-04; monthly cadence). 881 KB min / 251 KB gzip full bundle before tree-shaking; v8 single import root improves tree-shaking.

- **Renderer, not framework.** Sim is deterministic fixed-timestep plain TS we own. Phaser/Kaplay/Excalibur want to own loop/scene/physics. Pixi gives render, scene graph, input surface, texture pipeline — no opinion about time.
- **CRT post-processing nearly free — the biggest differentiator.** `pixi-filters` v6.x ships **CRTFilter** (curvature, lineContrast, noise, vignetting/Alpha/Blur), **GlitchFilter** (slices, per-channel RGB split, refresh()/redraw() per-frame glitch), **BulgePinchFilter** (barrel). Filters on root Container = fullscreen post. 40+ filters. Custom `Filter` takes GLSL and WGSL.
- **Breakable-part robots** = Containers of Sprites; a part breaking off is a reparent to world with its own velocity.
- **Pixel art**: per-texture/global `scaleMode: 'nearest'`; one atlas → a handful of draw calls (16 textures/draw batch).
- **Portability is the trivial case**: Vite static build, relative paths, zero runtime CDN, zero wasm — simultaneously what Discord CSP wants, Poki demands, CrazyGames measures. CrazyGames lists Pixi as compatible.

Costs: (1) **no built-in tilemap** — `@pixi/tilemap` v8-compat UNVERIFIED; hand-roll a chunked tilemap renderer (~150 lines) instead. (2) **AI-agent hazard: v7-vs-v8 drift** — LLMs emit v7 confidently (`new Application(opts)` / `app.view` vs v8 `await app.init({...})` / `app.canvas`); mitigate with hard rules in the repo CLAUDE.md.

## 2. Runner-up: Phaser 4

Phaser 4.2 (2026-07-21); 356 KB gzip; full ESM rewrite, "sub-200KB" tree-shaken claimed; WebGL2 renderer "Beam"; WebGPU roadmap-only. Advantage: **Discord-proven** — official Activity guide + template (phaserjs/discord-template), one of two frameworks in discord/embedded-app-sdk-examples; Poki lists Phaser 3 as supported; Tiled import free. Switch if tilemap/Tiled pipeline becomes a sink or off-the-shelf scene/camera wanted. **Not more AI-friendly: LLM corpus is Phaser 3**, whose postFX API no longer exists; Phaser 4 custom post-FX maturity UNVERIFIED — verify CRT story first if considering.

## 3. Per-candidate verdicts

| Candidate | Verdict |
|---|---|
| PixiJS v8 | **Pick.** Renderer-only fits self-owned sim; CRT/glitch/barrel stock; 251 KB gzip, no wasm, CSP-clean. Hand-roll tilemap; guard v7 drift. |
| Phaser 4 | Runner-up; only candidate with official Discord Activity template. LLMs know Phaser 3 not 4; post-FX unverified. |
| Godot 4.7 web | **No.** Web export: "Audio effects, reverberation, and procedural audio generation are unsupported" — fatal for layered SFX + streamed TTS. 20–35 MB wasm typical. Tab-background pauses. Not TS. (Single-threaded builds default since 4.3 do work on itch/Poki/CG/iOS.) |
| Defold 1.13.0 | Best portal citizen (Poki Corporate Gold Partner, first-class export). **Lua, not TS** — wrong language for AI-agent workflow; sim would need porting. |
| Unity 6 web | Refuted: empty 2D template 7.7 MB Brotli — half of CG's 20 MB mobile budget on nothing. |
| KAPLAY | TS-native, charming, beta-tagged, owns the loop. No. |
| Excalibur.js | TS-native, pre-1.0 churn, owns the loop. Fine engine, wrong shape. |
| LittleJS | Emergency option if a portal size cap gets brutal. Thin ecosystem, no filter lib. |
| Construct 3 | No. Subscription, editor-centric, not agent-editable TS. |

## 4. Hard risks

**R1 — Discord Activity microphone: BLOCKED (highest severity).** Responses in order of confidence:
- (a) **Design for degradation regardless**: one `CommandSource` interface; Discord ships typed/hotkey command palette, web ships voice; sim never knows. Also an accessibility feature.
- (b) Discord bot voice-receive → server STT → text into Activity via ws. Prior art exists (AssemblyAI voice bot, dtinth/discord-transcriber, Gladia). Caveat: `@discordjs/voice` receive is experimental/discouraged; adds bot install, guild perms, latency, per-minute STT cost.
- (c) Wait for #363 — do not plan around it.

**R2 — Web Speech API "partial" everywhere** (caniuse ~87% global): Chrome partial since 25; Safari desktop 14.1+/iOS 14.5+ partial; **Firefox disabled by default**; caniuse marks **Edge unsupported** — contradicts common assumption, test a real device. iOS Safari worst: `continuous` misbehaves, dropped words, `interimResults` unreliable, iOS 17 regressions; workaround = timeout-based stop()+restart per phrase, or getUserMedia + server STT.

**R2b — Chrome 139 (Aug 2025) shipped on-device recognition**: `processLocally`, `SpeechRecognition.install()/available()`, quality `'command'|'dictation'|'conversation'` — `'command'` is exactly our case: low latency, offline, audio never leaves device. Non-local Chrome sends audio to Google (privacy disclosure line needed).

**R3 — whisper-wasm too big for initial bundle**: whisper-tiny ONNX ~25–50 MB realistic (decoder q4f16 45.7 MB); whisper-base WebGPU demo ~200 MB. Never in first load; lazy-load post-`gameplayStart` only when Web Speech absent. Browser WebGPU real-time-factor numbers NOT FOUND — benchmark before committing.

**R4 — Poki blocks ALL external requests by default** (fonts, assets, CDN libs; multiplayer/analytics case-by-case). No splash screens/outgoing links; playable with ad blocker; localStorage in try/catch; 16:9 scaling refs 640×360 / 836×470 / 1031×580; mobile/tablet fullscreen. No published numeric size caps — inspector.poki.dev is the authority.

**R5 — CrazyGames hard numbers**: total ≤250 MB; initial ≤50 MB; ≤20 MB for mobile homepage; ≤1,500 files; **relative paths only**; ≤20 s to gameplay (to first `gameplayStart` SDK event). Day-one mobile items: `-webkit-user-select:none` family, iOS AudioContext resume after interruption. First-frame perception guide: <100 ms instant, 1 s fine, 10 s gone.

**Convergence (the useful part): Discord CSP + Poki external-block + CrazyGames relative-paths all demand the same thing — fully self-contained static bundle, no runtime CDN, no remote wasm, no dynamic-import-from-URL. Build to that from commit one and all three ports are near-free.** (Same failure class as the Chips-of-Fury/Firebase postmortem: dynamic loading kills, not the vendor.)

**R6 — Discord CSP mechanics**: URL-mapping prefix→target through Discord's proxy; allowlisted bypasses only Discord's own domains. Consistent with Ringmaster's `/.proxy` notes.

**R7 — 30-minute spikes before trusting:** (i) WebGPU inside Discord Electron — force `preference:'webgl'` for Discord build, WebGPU opportunistic web-only; (ii) `@pixi/tilemap` on v8; (iii) Phaser 4 post-FX maturity; (iv) Edge SpeechRecognition reality.

**R8 — Discord mobile**: Activities in iOS/Android webviews; `--discord-safe-area-inset-*` CSS vars; thermal events on Android 10+; assume mic LESS available there.

## 5. Suggested repo shape (agent's proposal — see GAME_SPEC §10 for the adopted, slimmer version)

```
packages/
  sim/     pure deterministic TS, fixed-timestep step(state, inputs) -> state, seeded RNG, zero DOM, never imports pixi (lint-enforced)
  shared/  types + command vocabulary (intent union) + zod
  render/  PixiJS v8 only; part-composition, chunked tilemap, CRT stack on root; reads sim, writes nothing
  audio/   raw WebAudio; master gain -> {sfx, tts}; streamed Eleven flash chunks via AudioBufferSourceNode queue; iOS unlock/auto-resume
  voice/   CommandSource: WebSpeechSource (processLocally 'command' on Chrome 139+), WhisperWasmSource (lazy), ServerSttSource (Discord bot), TypedSource (palette; Discord default + a11y)
  app/     Vite SPA; PortalHost adapters (web/discord/poki/crazygames); base:'./' relative everything
  server/  TTS proxy (key server-side); optionally Discord bot + STT worker
```

Day-one CLAUDE.md non-negotiables: (1) no runtime CDN / remote wasm / dynamic-import-from-URL anywhere; (2) `base:'./'`, relative paths only; (3) Pixi v8 API rules (`await app.init()`, `app.canvas`) to stop agents writing v7; (4) voice is a `CommandSource` — any feature assuming a mic exists is a bug.

**Check before writing code:** stand up a 20-line Discord Activity calling `getUserMedia({audio:true})` and confirm the rejection first-hand — #363 is one developer's report, not a Discord statement.
