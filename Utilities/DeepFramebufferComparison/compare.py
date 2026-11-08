#!/usr/bin/env python3
"""Compare local native WebGPU and browser captures without a tolerance.

Inputs are actual native PNGs and top-to-bottom browser RGBA readbacks.
Outputs preserve every mismatch, including alpha and single-level differences.
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "Utilities/TestResults/deep-transparency/native-webgpu"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--specs", type=Path, default=ROOT / "Data/deep-transparency/comparison/specs")
    parser.add_argument("--cases", help="Comma-separated case names")
    parser.add_argument("--report-only", action="store_true", help="Write all failures while returning success")
    args = parser.parse_args()
    index = json.loads((args.specs / "index.json").read_text())
    selected = set(args.cases.split(",")) if args.cases else None
    results = []
    previews = []
    for case in index["cases"]:
        name = case["name"]
        if selected and name not in selected:
            continue
        spec_path = args.specs / f"{name}.json"
        spec = json.loads(spec_path.read_text())
        native_path = args.captures / "native" / f"{name}.png"
        browser_raw = args.captures / "browser" / f"{name}.rgba"
        native = Image.open(native_path).convert("RGBA")
        browser = Image.frombytes("RGBA", (spec["width"], spec["height"]), browser_raw.read_bytes())
        if native.size != browser.size:
            raise RuntimeError(f"{name}: dimensions differ: {native.size} vs {browser.size}")
        browser_path = browser_raw.with_suffix(".png")
        browser.save(browser_path)
        native_array = np.asarray(native)
        browser_array = np.asarray(browser)
        delta = np.abs(native_array.astype(np.int16) - browser_array.astype(np.int16))
        mismatched = np.any(delta != 0, axis=2)
        native_metadata = json.loads(native_path.with_suffix(".json").read_text())
        browser_metadata = json.loads(browser_raw.with_suffix(".json").read_text())
        if native_metadata["specificationSHA256"] != digest(spec_path):
            raise RuntimeError(f"{name}: native specification does not match")
        if browser_metadata["specificationSHA256"] != digest(spec_path):
            raise RuntimeError(f"{name}: browser specification does not match")
        if native_metadata.get("errors") or browser_metadata.get("errors") or browser_metadata.get("gpuErrors"):
            raise RuntimeError(f"{name}: capture has rendering errors")
        if native_metadata.get("sharedPoolExhausted"):
            raise RuntimeError(f"{name}: native shared fragment pool was exhausted")
        if browser_metadata.get("orderDifferingChannels"):
            raise RuntimeError(f"{name}: browser image changed with actor order")
        (args.captures / f"{name}-absolute-difference.rgba").write_bytes(delta.astype(np.uint8).tobytes())
        raw_diff = Image.fromarray(delta[:, :, :3].astype(np.uint8), "RGB")
        diff_path = args.captures / f"{name}-absolute-difference.png"
        raw_diff.save(diff_path)
        Image.fromarray(delta[:, :, 3].astype(np.uint8), "L").save(args.captures / f"{name}-alpha-difference.png")
        amplified = np.minimum(delta[:, :, :3] * 8, 255).astype(np.uint8)
        alpha_diff = delta[:, :, 3] != 0
        amplified[alpha_diff, 0] = np.maximum(amplified[alpha_diff, 0], 128)
        amplified[alpha_diff, 2] = np.maximum(amplified[alpha_diff, 2], 128)
        amplified_image = Image.fromarray(amplified, "RGB")
        amplified_image.save(args.captures / f"{name}-difference-x8.png")
        result = {
            "name": name,
            "mode": spec["mode"],
            "width": spec["width"],
            "height": spec["height"],
            "pixelPerfect": not bool(mismatched.any()),
            "differingPixels": int(mismatched.sum()),
            "totalPixels": int(mismatched.size),
            "differingChannels": int(np.count_nonzero(delta)),
            "differingAlphaPixels": int(alpha_diff.sum()),
            "maximumChannelError": int(delta.max()),
            "maximumErrorPerChannel": [int(delta[:, :, i].max()) for i in range(4)],
            "rootMeanSquareChannelError": float(np.sqrt(np.mean(delta.astype(float) ** 2))),
            "specificationSHA256": digest(spec_path),
            "nativeImageSHA256": digest(native_path),
            "browserRawSHA256": digest(browser_raw),
            "native": native_metadata,
            "browser": browser_metadata,
        }
        results.append(result)
        preview_size = (400, 400)
        tile = Image.new("RGB", (1200, 430), (17, 23, 32))
        draw = ImageDraw.Draw(tile)
        for column, (label, image) in enumerate([
            (f"{name}: local C++ WebGPU", native),
            ("VTK.js WebGPU", browser),
            (f"Absolute difference x8: {result['differingPixels']} pixels", amplified_image),
        ]):
            draw.text((column * 400 + 8, 8), label, fill="white")
            tile.paste(image.convert("RGB").resize(preview_size), (column * 400, 30))
        previews.append((spec["mode"], tile))
        print(f"{name}: {'EXACT' if result['pixelPerfect'] else 'DIFFERS'}, {result['differingPixels']}/{result['totalPixels']} pixels, max {result['maximumChannelError']}, alpha {result['differingAlphaPixels']}")
    if not results:
        raise RuntimeError("No comparison cases selected")
    report = {"criterion": "Every RGBA channel equal, zero tolerance", "results": results}
    (args.captures / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    if previews:
        contact = Image.new("RGB", (1200, len(previews) * 430))
        for row, (_, tile) in enumerate(previews):
            contact.paste(tile, (0, row * 430))
        contact.save(args.captures / "comparison.png")
        for mode in ["unlit", "pbr"]:
            tiles = [tile for item_mode, tile in previews if item_mode == mode]
            if tiles:
                sheet = Image.new("RGB", (1200, len(tiles) * 430))
                for row, tile in enumerate(tiles):
                    sheet.paste(tile, (0, row * 430))
                sheet.save(args.captures / f"comparison-{mode}.png")
    if any(not result["pixelPerfect"] for result in results) and not args.report_only:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
