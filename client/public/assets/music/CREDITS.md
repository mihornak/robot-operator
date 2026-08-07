# Music credits

## boss.mp3 — the shredder fight (floor 6)

- **Title:** Boss Battle #1 (V1)
- **Author:** nene
- **Source:** https://opengameart.org/content/boss-battle-1-8-bit-re-upload
- **Licence:** CC0 1.0 (public domain). No attribution is required — this file
  exists because knowing where a shipped asset came from is worth more than the
  licence obliging it.

Shipped as mono 32 kHz 64 kbps MP3 (1.6 MB) from the original 35.9 MB stereo
WAV. Mono because the whole game is a mono CRT feed, and 64 kbps because
chiptune is spectrally sparse: measured 19.7 dB SDR against the source, against
17.2 at 48 kbps and 21.7 at 80 kbps — the knee of that curve.

The full 3:23 is bundled rather than a cut loop. The author's track already
loops end to end, so no seam had to be invented, and the fight is ~45 seconds:
nobody reaches the wrap. It is fetched on ENTERING floor 6, not at page load
(see prefetchMusic in game/director.ts), so players who never reach the arena
never pay for it.
