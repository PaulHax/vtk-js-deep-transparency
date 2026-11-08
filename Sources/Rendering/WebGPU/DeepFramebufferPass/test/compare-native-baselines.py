#!/usr/bin/env python3
"""Write comparison metrics and a contact sheet from saved browser captures."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, required=True)
    args = parser.parse_args()
    scenes = json.loads((HERE / "scenes.json").read_text())["scenes"]
    rows = []
    report = {}
    for name in scenes:
        reference_image = Image.open(HERE / "baselines" / f"{name}.png").convert("RGBA")
        capture_image = Image.open(args.captures / f"{name}-webgpu.png").convert("RGBA")
        reference = np.array(reference_image, dtype=int)
        captured = np.array(capture_image, dtype=int)
        delta = np.abs(captured - reference)
        per_pixel_error = delta.max(axis=2)
        boundary = np.zeros(per_pixel_error.shape, dtype=bool)
        invalid = 0
        for y in range(reference.shape[0]):
            for x in range(reference.shape[1]):
                neighbors = reference[max(0, y - 1):y + 2, max(0, x - 1):x + 2]
                boundary[y, x] = np.any(np.abs(neighbors - reference[y, x]) > 1)
                if per_pixel_error[y, x] > 1:
                    nearest_error = np.abs(neighbors - captured[y, x]).max(axis=2).min()
                    if not boundary[y, x] or nearest_error > 1:
                        invalid += 1
        report[name] = {
            "width": reference_image.width,
            "height": reference_image.height,
            "differingPixels": int(np.count_nonzero(per_pixel_error)),
            "differingChannels": int(np.count_nonzero(delta)),
            "maximumChannelError": int(delta.max()),
            "pixelsExceedingOneChannelLevel": int(np.count_nonzero(per_pixel_error > 1)),
            "nativeBoundaryPixels": int(boundary.sum()),
            "maximumStableInteriorChannelError": int(delta[~boundary].max()),
            "pixelsOutsideOnePixelBoundaryAndOneChannelLevelAllowance": invalid,
            "comparison": "one-pixel native boundary neighborhood, one channel level in stable interiors"
            if name.endswith("spheres") else "exact full image",
        }
        difference_image = Image.fromarray(np.minimum(delta[:, :, :3] * 8, 255).astype("uint8"))
        difference_image.save(args.captures / f"{name}-diff.png")
        reference_image.save(args.captures / f"{name}-native.png")
        row = Image.new("RGB", (3 * reference_image.width, reference_image.height + 32), "#141924")
        draw = ImageDraw.Draw(row)
        for column, (label, image) in enumerate([
            ("Native C++ depth peeling", reference_image),
            ("VTK.js deep framebuffer", capture_image),
            ("Absolute difference x8", difference_image),
        ]):
            draw.text((column * reference_image.width + 8, 8), label, fill="white")
            row.paste(image, (column * reference_image.width, 32))
        rows.append(row)
    sheet = Image.new("RGB", (rows[0].width, sum(row.height for row in rows)), "black")
    top = 0
    for row in rows:
        sheet.paste(row, (0, top))
        top += row.height
    sheet.save(args.captures / "native-comparison.png")
    (args.captures / "native-comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
