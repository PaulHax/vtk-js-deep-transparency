#!/usr/bin/env python3
"""Independently verify the published opaque PBR evidence without rendering.

Lossless PNG pixels reproduce full-image RGBA metrics and captured browser-byte
hashes. Normalized scene and metadata paths are portable descriptions; their
capture-time SHA256 identifiers do not describe the normalized JSON bytes.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EVIDENCE = Path(__file__).resolve().parent / "evidence"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def member(root, relative):
    candidate = (root / relative).resolve()
    require(candidate.is_relative_to(root.resolve()), f"Path escapes evidence root: {relative}")
    return candidate


def safe_name(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value), f"Invalid scene or variant name: {value!r}")
    return value


def metrics(reference, candidate, mask=None):
    a = reference if mask is None else reference[mask]
    b = candidate if mask is None else candidate[mask]
    if not a.size:
        return None
    delta = np.abs(a.astype(np.int16) - b.astype(np.int16))
    rgb = delta[..., :3]
    return {
        "totalPixels": int(np.prod(a.shape[:-1])),
        "pixelPerfect": not bool(np.any(delta)),
        "differingRGBAPixels": int(np.count_nonzero(np.any(delta != 0, axis=-1))),
        "differingRGBPixels": int(np.count_nonzero(np.any(rgb != 0, axis=-1))),
        "differingChannels": int(np.count_nonzero(delta)),
        "differingAlphaPixels": int(np.count_nonzero(delta[..., 3])),
        "maximumRGBAError": int(delta.max()),
        "maximumErrorPerChannel": delta.reshape(-1, 4).max(axis=0).astype(int).tolist(),
        "meanAbsoluteRGBError": float(rgb.mean()),
        "rootMeanSquareRGBError": math.sqrt(float(np.mean(rgb.astype(float) ** 2))),
    }


def verify_values(actual, expected, label):
    if actual is None:
        require(expected is None, f"{label}: expected an empty diagnostic subset")
        return
    require(isinstance(expected, dict), f"{label}: missing stored metrics")
    for key, value in actual.items():
        require(key in expected, f"{label}: missing {key}")
        stored = expected[key]
        if isinstance(value, float):
            require(isinstance(stored, (int, float)) and math.isclose(value, stored, rel_tol=1e-12, abs_tol=1e-12), f"{label}/{key}: {value!r} != {stored!r}")
        else:
            require(value == stored, f"{label}/{key}: {value!r} != {stored!r}")


def rgba(path, width, height):
    with Image.open(path) as image:
        require(image.mode == "RGBA", f"{path.name}: evidence image must be RGBA")
        require(image.size == (width, height), f"{path.name}: dimensions differ from scene")
        return np.asarray(image).copy()


def interior_mask(native, final):
    shared = np.any(native[..., :3] != 0, axis=2) & np.any(final[..., :3] != 0, axis=2)
    padded = np.pad(shared, 2, constant_values=False)
    mask = np.ones(shared.shape, dtype=bool)
    for y in range(5):
        for x in range(5):
            mask &= padded[y:y+shared.shape[0], x:x+shared.shape[1]]
    return mask


def center_values(pixels):
    y, x = pixels.shape[0] // 2, pixels.shape[1] // 2
    return pixels[y, x].astype(int).tolist(), pixels[y-4:y+4, x-4:x+4, :3].mean(axis=(0, 1)).tolist()


def numeric_scene(value):
    if isinstance(value, dict):
        return {k: numeric_scene(v) for k, v in value.items() if k not in {"path", "url"}}
    if isinstance(value, list):
        return [numeric_scene(v) for v in value]
    return value


def verify_capture(metadata, specification, original_hash, variant=None):
    label = specification["name"] + ("/" + variant if variant else "/native")
    require(metadata.get("errors") == [], f"{label}: errors must be an empty list")
    require(metadata.get("deepFramebufferEnabled") is False, f"{label}: deep framebuffer must be disabled")
    require(metadata.get("specificationSHA256") == original_hash, f"{label}: capture-time specification identifier differs")
    require(metadata.get("name") == specification["name"] and metadata.get("mode") == specification["mode"], f"{label}: scene identity differs")
    require((metadata.get("width"), metadata.get("height")) == (specification["width"], specification["height"]), f"{label}: capture dimensions differ")
    geometry = metadata.get("geometry", [])
    require(len(geometry) == len(specification["actors"]), f"{label}: actor counts differ")
    if variant is not None:
        require(metadata.get("variant") == variant, f"{label}: variant identity differs")
        require(metadata.get("gpuErrors") == [], f"{label}: GPU errors must be an empty list")
        require(metadata.get("sampleCount") == 1, f"{label}: expected one sample")
        if "float-normals" in variant:
            diagnostics = metadata.get("bufferDiagnostics", {})
            require(diagnostics.get("normalOverrides", 0) > 0 and diagnostics.get("normalFormat") == "float32x4", f"{label}: float-normal override was not exercised")
        if specification["mode"] == "pbr":
            require(bool(metadata.get("shaders")), f"{label}: PBR shader evidence is missing")
    else:
        require(metadata.get("samplesPerPixel") == 1, f"{label}: expected one sample")
        require(numeric_scene(metadata.get("specification")) == numeric_scene(specification), f"{label}: normalized scene values differ from native capture")
    for actual, actor in zip(geometry, specification["actors"]):
        require(actual.get("points") == actor["pointCount"], f"{label}: point counts differ")
        require(actual.get("polygons" if variant else "triangles") == actor["triangleCount"], f"{label}: polygon counts differ")
        if variant is None:
            require(actual.get("sha256") == actor["sha256"], f"{label}: native mesh identifier differs")


def verify(evidence, source_root):
    manifest = read_json(evidence / "manifest.json")
    summary = read_json(evidence / "summary.json")
    metadata = read_json(evidence / "capture-metadata.json")
    scene_records = read_json(evidence / "scene-specifications.json")
    require(manifest.get("schemaVersion") == 1, "Unsupported evidence manifest schema")
    artifacts = manifest.get("artifacts", {})
    require(bool(artifacts), "Manifest has no artifact hashes")
    for relative, record in artifacts.items():
        path = member(evidence, relative)
        require(path.is_file(), f"Missing artifact: {relative}")
        require(path.stat().st_size == record["bytes"] and digest(path) == record["sha256"], f"Artifact checksum or size differs: {relative}")
    source_hashes = manifest.get("renderingAndNativeCaptureSourceSHA256", {})
    for relative, expected in source_hashes.items():
        require(digest(member(source_root, relative)) == expected, f"Source checksum differs: {relative}")
    variants = summary["variants"]
    require(len(set(variants)) == len(variants), "Duplicate variant names")
    for variant in variants:
        safe_name(variant)
    results = summary["results"]
    names = [safe_name(row["name"]) for row in results]
    require(len(set(names)) == len(names), "Duplicate scene names")
    scenes = {record["name"]: record for record in scene_records}
    require(len(scenes) == len(scene_records) and set(scenes) == set(names), "Scene specifications do not match summary")
    require(set(metadata["native"]) == set(names) and set(metadata["browser"]) == set(variants), "Capture metadata index differs")
    for variant in variants:
        require(set(metadata["browser"][variant]) == set(names), f"Incomplete browser metadata: {variant}")
    final_variant = manifest["finalVariant"]
    require(final_variant in variants, "Final variant is absent")
    native_count = browser_count = alpha_errors = 0
    final_metrics, shader_hashes, mesh_hashes = [], set(), set()
    for row in results:
        name = row["name"]
        require(set(row["variants"]) == set(variants), f"{name}: variant set differs")
        record = scenes[name]
        spec = record["specification"]
        original_hash = record["originalSpecificationSHA256"]
        require(original_hash == row["specificationSHA256"], f"{name}: original specification identifier differs")
        require(spec["name"] == name and spec["mode"] == row["mode"] and spec["material"] == row["material"], f"{name}: normalized specification values differ")
        require(spec["camera"]["parallelProjection"] == row["parallelProjection"], f"{name}: projection differs")
        require(spec["deepFramebuffer"] is False and spec["multiSample"] == 1, f"{name}: invalid scene controls")
        require([actor["sha256"] for actor in spec["actors"]] == row["meshSHA256"], f"{name}: mesh identifiers differ")
        for actor in spec["actors"]:
            require(actor["opacity"] == 1, f"{name}: actor is not opaque")
            mesh = member(evidence, actor["path"])
            require(digest(mesh) == actor["sha256"], f"{name}: bundled mesh checksum differs")
            piece = ET.parse(mesh).getroot().find("./PolyData/Piece")
            require(piece is not None and int(piece.attrib["NumberOfPoints"]) == actor["pointCount"] and int(piece.attrib["NumberOfPolys"]) == actor["triangleCount"], f"{name}: bundled mesh counts differ")
            mesh_hashes.add(actor["sha256"])
        native_path = member(evidence, "native/" + name + ".png")
        native = rgba(native_path, spec["width"], spec["height"])
        native_meta = metadata["native"][name]
        require(digest(native_path) == row["nativeImageSHA256"] == native_meta["captureImageSHA256"], f"{name}: native PNG checksum differs")
        require(native_meta["offscreenColorFormat"] == row["nativeFormat"], f"{name}: native attachment format differs")
        verify_capture(native_meta, spec, original_hash)
        native_center, native_mean = center_values(native)
        require(native_center == row["nativeCenterPixelRGBA"] and native_mean == row["nativeCenter8x8MeanRGB"], f"{name}: native center measurements differ")
        native_count += 1
        browsers = {variant: rgba(member(evidence, "browser/" + variant + "/" + name + ".png"), spec["width"], spec["height"]) for variant in variants}
        mask_variant = row["interiorMask"]["finalVariant"]
        require(mask_variant in browsers, f"{name}: invalid diagnostic mask variant")
        mask = interior_mask(native, browsers[mask_variant])
        require(int(mask.sum()) == row["interiorMask"]["pixelCount"], f"{name}: diagnostic mask size differs")
        for variant, pixels in browsers.items():
            label = name + "/" + variant
            stored = row["variants"][variant]
            browser_meta = metadata["browser"][variant][name]
            verify_capture(browser_meta, spec, original_hash, variant)
            raw_hash = hashlib.sha256(pixels.tobytes()).hexdigest()
            require(raw_hash == stored["rawSHA256"] == browser_meta["captureRGBASHA256"], f"{label}: decoded RGBA checksum differs")
            require(browser_meta["colorAttachmentFormat"] == stored["colorAttachmentFormat"] and browser_meta["presentationFormat"] == stored["presentationFormat"], f"{label}: attachment or presentation format differs")
            require(browser_meta.get("bufferDiagnostics") == stored["bufferDiagnostics"], f"{label}: buffer diagnostics differ")
            actual = metrics(native, pixels)
            verify_values(actual, stored["fullImage"], label + "/fullImage")
            verify_values(metrics(native, pixels, mask), stored["interior"], label + "/interior")
            verify_values(metrics(browsers["baseline"], pixels), stored["changeFromBaseline"], label + "/changeFromBaseline")
            center, mean = center_values(pixels)
            require(center == stored["centerPixelRGBA"] and mean == stored["center8x8MeanRGB"], f"{label}: browser center measurements differ")
            hashes = [shader["sha256"] for shader in browser_meta["shaders"]]
            require(hashes == stored["shaderSHA256"], f"{label}: shader identities differ")
            for shader_hash in hashes:
                require(bool(re.fullmatch(r"[0-9a-f]{64}", shader_hash)), f"{label}: invalid shader hash")
                require(digest(member(evidence, "shaders/" + shader_hash + ".wgsl")) == shader_hash, f"{label}: shader bytes differ")
                shader_hashes.add(shader_hash)
            browser_count += 1
            alpha_errors += actual["differingAlphaPixels"]
            if variant == final_variant:
                final_metrics.append(actual)
    observed = {
        "sceneCount": len(names), "variantCount": len(variants),
        "nativeCaptureCount": native_count, "browserCaptureCount": browser_count,
        "uniqueShaders": len(shader_hashes),
        "strictlyIdenticalFinalScenes": sum(item["pixelPerfect"] for item in final_metrics),
        "finalNonExactScenes": sum(not item["pixelPerfect"] for item in final_metrics),
        "finalMaximumRGBAError": max(item["maximumRGBAError"] for item in final_metrics),
    }
    for key, value in observed.items():
        if key in manifest:
            require(value == manifest[key], f"Manifest {key}: observed {value}, declared {manifest[key]}")
    require(browser_count == len(names) * len(variants), "Capture matrix is incomplete")
    observed.update({"finalVariant": final_variant, "differingAlphaPixelsAcrossAllComparisons": alpha_errors,
                     "verifiedArtifactFiles": len(artifacts), "verifiedSourceFiles": len(source_hashes),
                     "uniqueMeshes": len(mesh_hashes), "summarySHA256": digest(evidence / "summary.json")})
    return observed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        result = verify(args.evidence.resolve(), args.source_root.resolve())
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        print(f"Evidence verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
