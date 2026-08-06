"""
Approach A of the 3D-asset question: 3D at BUILD time, 2D at runtime.

Renders a glTF/GLB (or .blend) through the game's camera and straight down onto
the game's palette, producing a pixel sprite `client/src/art/sprites/` can ship
exactly like a code-drawn one. Nothing 3D reaches the browser: no three.js, no
runtime loader, no .glb in the bundle, no licence question about shipping a
model players can extract.

The camera is not a choice made here — it is the one the tilemap already
implies. A wall in `art/tiles.ts` is a 16px top over a 16px face, i.e. a tile of
height h projects to h vertically: a 45° elevation, orthographic, no vanishing
point. Match that and a rendered prop sits in the room instead of on top of it.

    blender --background --python tools/render-sprite.py -- \
        --in ~/Downloads/office_chair.glb \
        --out client/src/art/sprites/office_chair.png \
        --size 14x18 --yaw 30

Writes `<out>` plus `<out>.json` (the measured ground-contact anchor, which is
what `ART[name].anchor` wants — the sprite's feet, not its middle).

Cycles/CPU on purpose: EEVEE and Workbench both want a GPU context, which is
exactly what `--background` does not have. At these resolutions CPU is instant.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

# --------------------------------------------------------------- palette

# client/src/art/palette.ts. Dark→light; the world is near-monochrome cold gray
# and props live in the structural range, never the robot's orange.
#
# The floor is #181b20, so the ramp STARTS above it. A physically honest darkest
# step would be correct and invisible: hand-drawn props here (`drawCrate`) never
# go below the floor tone either, except for the single contact-shadow line.
WORLD_RAMP = ["#1e2227", "#2a2f36", "#3a4048", "#4a525c", "#5d6671", "#8e939a"]

# Where the ramp steps fall in the value histogram, as percentiles. Uniform
# (equal-population) buckets read as noise: a sixth of every prop comes out at
# full highlight. Real pixel art is mostly midtone with a thin rim, which is
# what this curve is — mass in the middle, the top step reserved for specular.
DEFAULT_CUTS = [14.0, 36.0, 62.0, 84.0, 95.0]


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


# --------------------------------------------------------------- scene


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_model(path: str) -> list[bpy.types.Object]:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = src.objects
        for ob in dst.objects:
            if ob is not None:
                bpy.context.scene.collection.objects.link(ob)
    else:
        raise SystemExit(f"unsupported input: {ext}")
    bpy.context.view_layer.update()
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def world_bbox(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for ob in meshes:
        for corner in ob.bound_box:
            p = ob.matrix_world @ Vector(corner)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return lo, hi


def make_camera(
    lo: Vector, hi: Vector, elev_deg: float, yaw_deg: float, w: int, h: int, pad: float
) -> tuple[bpy.types.Object, float]:
    """Orthographic camera at `elev_deg` above horizon, framing the bbox.

    Returns the camera and the sprite row (0..1 from the top) where the model's
    ground-contact point lands — the anchor the manifest needs.
    """
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.sensor_fit = "HORIZONTAL"
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    # Blender's camera looks down -Z; rot_x = 90° is horizontal, so the pitch we
    # want is 90° - elevation. Z last, swinging the whole rig around the model.
    cam.rotation_euler = (math.radians(90.0 - elev_deg), 0.0, math.radians(yaw_deg))

    centre = (lo + hi) * 0.5
    # From the euler directly — matrix_world is a frame stale at this point.
    basis = cam.rotation_euler.to_matrix()
    right = basis @ Vector((1.0, 0.0, 0.0))
    up = basis @ Vector((0.0, 1.0, 0.0))
    fwd = basis @ Vector((0.0, 0.0, -1.0))

    corners = [
        Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)
    ]
    ext_r = max(abs((c - centre).dot(right)) for c in corners)
    ext_u = max(abs((c - centre).dot(up)) for c in corners)

    # ortho_scale spans the render WIDTH (sensor_fit HORIZONTAL), so the height
    # it buys is scale * h/w — take whichever constraint binds.
    scale = max(ext_r * 2.0, ext_u * 2.0 * (w / h)) * (1.0 + pad)
    cam_data.ortho_scale = scale

    depth = (hi - lo).length * 3.0 + 1.0
    cam.location = centre - fwd * depth
    cam_data.clip_start = 0.01
    cam_data.clip_end = depth * 3.0

    # Where the model touches the floor, in sprite space. Ground contact is the
    # bbox centre in XY at its lowest Z — the point the tile grid must align to.
    ground = Vector((centre.x, centre.y, lo.z))
    v = (ground - centre).dot(up) / (scale * h / w)  # -0.5..0.5, +up
    anchor_y = 0.5 - v
    return cam, anchor_y


def make_lights(lo: Vector, hi: Vector, elev_deg: float, yaw_deg: float) -> None:
    """Key from over the camera's left shoulder, weak ambient fill.

    Direction matters more than intensity: everything is normalised into the
    palette ramp afterwards, so this only has to separate the planes.
    """
    size = (hi - lo).length

    key = bpy.data.lights.new("key", type="SUN")
    key.energy = 4.0
    key.angle = math.radians(12.0)  # soft-ish terminator, no hard noise
    ko = bpy.data.objects.new("key", key)
    ko.rotation_euler = (math.radians(90.0 - (elev_deg + 18.0)), 0.0, math.radians(yaw_deg - 35.0))
    bpy.context.scene.collection.objects.link(ko)

    rim = bpy.data.lights.new("rim", type="SUN")
    rim.energy = 1.6
    ro = bpy.data.objects.new("rim", rim)
    ro.rotation_euler = (math.radians(90.0 - 25.0), 0.0, math.radians(yaw_deg + 145.0))
    bpy.context.scene.collection.objects.link(ro)

    # Bounce, straight down the camera axis and low. Without it every underside
    # — a chair's gas lift and star base, the thing that says "office" — renders
    # black, quantizes to the floor tone and disappears from the silhouette.
    bounce = bpy.data.lights.new("bounce", type="SUN")
    bounce.energy = 2.2
    bo = bpy.data.objects.new("bounce", bounce)
    bo.rotation_euler = (math.radians(90.0 - 8.0), 0.0, math.radians(yaw_deg))
    bpy.context.scene.collection.objects.link(bo)

    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.4, 0.42, 0.46, 1.0)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
    bpy.context.scene.world = world
    _ = size


def configure_render(w: int, h: int, samples: int, ss: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False  # denoise smears; we quantize anyway
    scene.render.resolution_x = w * ss
    scene.render.resolution_y = h * ss
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    # Standard, not AgX: we want the shader's values, not a film response curve.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"


# --------------------------------------------------------------- posterize


def to_sprite(
    raw_path: str,
    w: int,
    h: int,
    ss: int,
    ramp: list[str],
    cutoff: float,
    cuts_pct: list[float] | None,
) -> np.ndarray:
    """Supersampled render → hard-edged, palette-quantized RGBA uint8."""
    img = bpy.data.images.load(raw_path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h * ss, w * ss, 4)
    px = px[::-1]  # Blender images are bottom-up

    # Box-downsample in premultiplied space so transparent pixels don't bleed
    # their (undefined) colour into the edges.
    rgb = px[..., :3] * px[..., 3:4]
    a = px[..., 3]
    rgb = rgb.reshape(h, ss, w, ss, 3).mean(axis=(1, 3))
    a = a.reshape(h, ss, w, ss).mean(axis=(1, 3))
    solid = a > cutoff
    rgb = np.where(solid[..., None], rgb / np.maximum(a, 1e-5)[..., None], 0.0)

    # Luminance → ramp index by QUANTILE, not by linear stretch. A dark leather
    # office chair lit in a dark room occupies a sliver of the value range; a
    # linear map spends five of six palette steps on pixels that aren't there
    # and the sprite comes out a flat silhouette. Quantiles spend the whole ramp
    # on the pixels the model actually has, which is what a pixel artist does by
    # hand — pick values for readability, not for photometry.
    lum = np.sqrt(np.clip(rgb, 0.0, None) @ np.array([0.299, 0.587, 0.114], np.float32))
    colours = np.array([hex_to_rgb(c) for c in ramp], dtype=np.uint8)
    pct = (
        cuts_pct
        if cuts_pct and len(cuts_pct) == len(ramp) - 1
        else list(np.linspace(0.0, 100.0, len(ramp) + 1)[1:-1])
    )
    if solid.any():
        idx = np.searchsorted(np.percentile(lum[solid], pct), lum).astype(np.int32)
    else:
        idx = np.zeros(lum.shape, dtype=np.int32)
    idx = np.clip(idx, 0, len(ramp) - 1)

    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., :3] = colours[idx]
    out[..., 3] = np.where(solid, 255, 0)
    out[~solid] = 0
    bpy.data.images.remove(img)
    return out


def write_png(path: str, rgba: np.ndarray) -> None:
    h, w = rgba.shape[:2]
    img = bpy.data.images.new("sprite", width=w, height=h, alpha=True)
    flat = (rgba[::-1].astype(np.float32) / 255.0).reshape(-1)  # back to bottom-up
    img.pixels.foreach_set(flat)
    img.file_format = "PNG"
    img.filepath_raw = path
    img.save()
    bpy.data.images.remove(img)


# --------------------------------------------------------------- main


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="render-sprite")
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--size", default="16x16", help="sprite WxH in px")
    ap.add_argument("--yaw", type=float, default=0.0, help="turn the model, degrees")
    ap.add_argument("--elev", type=float, default=45.0, help="camera above horizon")
    ap.add_argument("--pad", type=float, default=0.04)
    ap.add_argument("--ss", type=int, default=6, help="supersample factor")
    ap.add_argument("--samples", type=int, default=48)
    ap.add_argument("--cutoff", type=float, default=0.45, help="alpha→opaque threshold")
    ap.add_argument("--ramp", default=",".join(WORLD_RAMP))
    ap.add_argument(
        "--cuts",
        default=",".join(str(c) for c in DEFAULT_CUTS),
        help="ramp-step percentiles, len(ramp)-1 of them; empty = equal population",
    )
    ap.add_argument(
        "--preview",
        type=int,
        default=0,
        help="also write <out>.preview.png upscaled N× (nearest) for eyeballing",
    )
    args = ap.parse_args(argv)

    w, h = (int(v) for v in args.size.lower().split("x"))
    ramp = [c.strip() for c in args.ramp.split(",") if c.strip()]

    clear_scene()
    meshes = import_model(os.path.expanduser(args.src))
    if not meshes:
        raise SystemExit("no meshes in input")
    lo, hi = world_bbox(meshes)
    _, anchor_y = make_camera(lo, hi, args.elev, args.yaw, w, h, args.pad)
    make_lights(lo, hi, args.elev, args.yaw)
    configure_render(w, h, args.samples, args.ss)

    dst = os.path.abspath(os.path.expanduser(args.dst))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    raw = dst + ".raw.png"
    bpy.context.scene.render.filepath = raw
    bpy.ops.render.render(write_still=True)

    cuts = [float(c) for c in args.cuts.split(",") if c.strip()]
    sprite = to_sprite(raw, w, h, args.ss, ramp, args.cutoff, cuts)
    write_png(dst, sprite)
    os.remove(raw)

    if args.preview > 1:
        n = args.preview
        big = np.repeat(np.repeat(sprite, n, axis=0), n, axis=1)
        # composite over the floor tone so transparency reads the way the game does
        floor = np.array(hex_to_rgb("#181b20"), dtype=np.uint8)
        flat = big[..., 3:4] == 0
        big = np.where(flat, np.concatenate([np.broadcast_to(floor, big.shape[:2] + (3,)),
                                             np.full(big.shape[:2] + (1,), 255, np.uint8)], axis=2), big)
        write_png(dst + ".preview.png", big)

    meta = {
        "source": os.path.basename(args.src),
        "size": [w, h],
        "yaw": args.yaw,
        "elev": args.elev,
        "anchor": [0.5, round(float(anchor_y), 3)],
    }
    with open(dst + ".json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[render-sprite] {dst} {w}x{h} anchor={meta['anchor']}")


if __name__ == "__main__":
    main()
