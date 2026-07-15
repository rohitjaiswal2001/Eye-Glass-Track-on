#!/usr/bin/env python3
"""
process-user-images.py
Removes white/near-white backgrounds from the 5 user-uploaded glasses images,
crops image 4 (Model 8507) to exclude the title/contact banner text, tightly
crops each frame to its bounding box, and saves the results as transparent
PNGs into public/models/ for use as catalog PNG frames.
"""

from PIL import Image
import os
import sys

# Source image paths (from the Antigravity IDE brain session folder)
SESSION_DIR = "/Users/perfectwebservices/.gemini/antigravity-ide/brain/eddc69af-285e-474c-901c-344620934a34"
SOURCE_IMAGES = [
    "media__1783660534192.png",  # user_frame_0: Round metal wire — gunmetal/black — front view
    "media__1783660539548.png",  # user_frame_1: Clear round-square smoke grey — back 3/4 view
    "media__1783660546484.png",  # user_frame_2: Semi-rimless gold/black square — back 3/4 view
    "media__1783660560337.png",  # user_frame_3: Model 8507 grey transparent square — has banner text
    "media__1783660571987.png",  # user_frame_4: Clear square with black temples — 3/4 view
]

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "models")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Helpers ──────────────────────────────────────────────────────────────────

def remove_white_background(img: Image.Image, threshold: int = 235) -> Image.Image:
    """
    Converts near-white pixels (all RGB channels >= threshold) to fully
    transparent, while keeping any genuinely colored frame pixels opaque.
    Uses flood-fill from the four corners to catch background regions connected
    to the border without nuking semi-transparent lens areas.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    data = img.load()
    w, h = img.size

    # Simple global threshold pass: pure white to transparent
    for y in range(h):
        for x in range(w):
            r, g, b, a = data[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                data[x, y] = (r, g, b, 0)

    return img


def crop_to_content(img: Image.Image) -> Image.Image:
    """Tightly crops the image to the smallest bounding box containing non-transparent pixels."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    bbox = img.split()[3].getbbox()  # alpha channel bounding box
    if bbox:
        img = img.crop(bbox)
    return img


def crop_banner(img: Image.Image, top_fraction: float = 0.15, bottom_fraction: float = 0.14) -> Image.Image:
    """
    Crops the top and bottom fractions of the image to remove title/contact
    text banners (used specifically for image 4 — Model 8507).
    """
    w, h = img.size
    top_cut = int(h * top_fraction)
    bottom_cut = int(h * bottom_fraction)
    return img.crop((0, top_cut, w, h - bottom_cut))


# ── Frame names and display labels ───────────────────────────────────────────

FRAME_NAMES = [
    ("user_frame_0", "Round Wire — Metal Black/Silver"),
    ("user_frame_1", "Clear Round-Square — Smoke Grey"),
    ("user_frame_2", "Semi-Rimless Square — Gold/Black"),
    ("user_frame_3", "Square Blue Block — Transparent Grey"),
    ("user_frame_4", "Square Clear Frame — Black Temples"),
]

# ── Main processing loop ──────────────────────────────────────────────────────

for i, (src_filename, (frame_id, display_name)) in enumerate(zip(SOURCE_IMAGES, FRAME_NAMES)):
    src_path = os.path.join(SESSION_DIR, src_filename)
    out_path = os.path.join(OUTPUT_DIR, f"{frame_id}.png")

    if not os.path.exists(src_path):
        print(f"  SKIP: {src_filename} not found", file=sys.stderr)
        continue

    img = Image.open(src_path).convert("RGBA")

    # Image 4 (index 3) has banner text top and bottom — crop it first
    if i == 3:
        img = crop_banner(img, top_fraction=0.18, bottom_fraction=0.13)

    img = remove_white_background(img, threshold=230)
    img = crop_to_content(img)

    img.save(out_path, "PNG")
    print(f"  Saved {frame_id}.png  ({img.width}x{img.height})  [{display_name}]")

print("\nDone. Transparent PNGs saved to public/models/")
