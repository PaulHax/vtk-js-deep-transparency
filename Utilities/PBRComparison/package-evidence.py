#!/usr/bin/env python3
"""Package lossless PBR evidence without raw capture buffers or machine paths."""

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CAPTURES = ROOT / "Utilities/TestResults/pbr-isolation"
DEFAULT_EVIDENCE = ROOT / "Utilities/PBRComparison/evidence"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--output", type=Path, default=DEFAULT_EVIDENCE)
    args = parser.parse_args()
    captures, output = args.captures.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    summary = read_json(captures / "analysis/summary.json")
    variants = summary["variants"]
    replacements = {str(ROOT): "."}
    chromium_directories = set()
    for result in summary["results"]:
        name = result["name"]
        meta = read_json(captures / "native" / (name + ".json"))
        build = meta["referenceBuild"]
        replacements[str(Path(build["vtk"]["sourceDirectory"]).parent)] = "<native-reference>"
        replacements[build["vtk"]["sourceDirectory"]] = "<native-vtk-source>"
        replacements[build["vtk"]["buildDirectory"]] = "<native-vtk-build>"
        icd = Path(build["adapterProbe"]["icd"])
        chromium_directories.add(icd.parent)
        for variant in variants:
            browser = read_json(captures / "browser" / variant / (name + ".json"))
            chromium_directories.add(Path(browser["browserExecutable"]).parent)
    for directory in chromium_directories:
        replacements[str(directory)] = "<" + directory.parent.name + ">"
    pairs = sorted(replacements.items(), key=lambda pair: -len(pair[0]))
    def portable(value):
        if isinstance(value, dict): return {key: portable(item) for key, item in value.items()}
        if isinstance(value, list): return [portable(item) for item in value]
        if isinstance(value, str):
            for before, after in pairs: value = value.replace(before, after)
        return value
    def copy(source, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    for filename in ["summary.json", "comparison.png", "sharp-residual.json"]:
        copy(captures / "analysis" / filename, output / filename)
    scenes = []
    metadata = {"native": {}, "browser": {variant: {} for variant in variants}}
    shader_count = set()
    source_records = {}
    runtime_records = {}
    reference_build = None
    for result in summary["results"]:
        name = result["name"]
        spec_path = captures / "specs" / (name + ".json")
        spec = read_json(spec_path)
        assert digest(spec_path) == result["specificationSHA256"]
        public_spec = portable(deepcopy(spec))
        for actor in public_spec["actors"]:
            actor["path"] = "meshes/" + Path(actor["path"]).name
            actor["url"] = actor["path"]
        scenes.append({"name": name, "originalSpecificationSHA256": digest(spec_path), "specification": public_spec})
        for actor in spec["actors"]:
            mesh = Path(actor["path"])
            assert digest(mesh) == actor["sha256"]
            copy(mesh, output / "meshes" / mesh.name)
        native = read_json(captures / "native" / (name + ".json"))
        metadata["native"][name] = portable(native)
        reference_build = native["referenceBuild"]
        copy(captures / "native" / (name + ".png"), output / "native" / (name + ".png"))
        for variant in variants:
            folder = captures / "browser" / variant
            browser = read_json(folder / (name + ".json"))
            metadata["browser"][variant][name] = portable(browser)
            copy(folder / (name + ".png"), output / "browser" / variant / (name + ".png"))
            runtime_records[browser["browserVersion"]] = {
                "browserVersion": browser["browserVersion"], "nodeVersion": browser["nodeVersion"],
                "browserExecutableSHA256": browser["browserExecutableSHA256"], "adapter": browser["adapter"],
            }
            for shader in browser.get("shaders", []):
                shader_path = folder / shader["file"]
                assert digest(shader_path) == shader["sha256"]
                copy(shader_path, output / "shaders" / (shader["sha256"] + ".wgsl"))
                shader_count.add(shader["sha256"])
    write_json(output / "scene-specifications.json", scenes)
    write_json(output / "capture-metadata.json", metadata)
    source_paths = [
        "Sources/Rendering/WebGPU/Renderer/index.js",
        "Sources/Rendering/WebGPU/CellArrayMapper/Replacements/Lighting.js",
        "Sources/Rendering/WebGPU/CellArrayMapper/Shaders.js",
        "Sources/Rendering/WebGPU/CellArrayMapper/VertexInput.js",
        "Sources/Rendering/WebGPU/BufferManager/index.js",
        "Sources/Rendering/WebGPU/RenderWindow/index.js",
        "Sources/Rendering/WebGPU/OpaquePass/index.js",
        "Utilities/PBRComparison/capture.cxx",
    ]
    for relative in source_paths: source_records[relative] = digest(ROOT / relative)
    driver_records = []
    for directory in sorted(chromium_directories):
        library = directory / "libvk_swiftshader.so"
        icd = directory / "vk_swiftshader_icd.json"
        driver_records.append({"distribution": directory.parent.name,
            "swiftShaderLibrarySHA256": digest(library), "vulkanICDSHA256": digest(icd),
            "role": "native" if str(icd) == reference_build["adapterProbe"]["icd"] else "browser"})
    final_variant = "cpp-equations-view-float-normals"
    final_results = [result["variants"][final_variant]["fullImage"] for result in summary["results"]]
    manifest = {
        "schemaVersion": 1,
        "sourceBaseCommit": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
        "nativeVTKRevision": reference_build["vtk"]["commit"],
        "nativeVTKSourceURL": reference_build["vtk"]["sourceUrl"],
        "nativeReferenceBuild": portable(reference_build),
        "browserRuntimes": list(runtime_records.values()), "swiftShaderDistributions": driver_records,
        "driverLimitation": "Browser and native captures use different SwiftShader builds. Runtime arithmetic is an unresolved contributor to the remaining single-level differences.",
        "sceneCount": len(scenes), "variantCount": len(variants), "browserCaptureCount": len(scenes)*len(variants),
        "nativeCaptureCount": len(scenes), "uniqueShaders": len(shader_count),
        "finalVariant": final_variant,
        "strictlyIdenticalFinalScenes": sum(result["pixelPerfect"] for result in final_results),
        "finalMaximumRGBAError": max(result["maximumRGBAError"] for result in final_results),
        "renderingAndNativeCaptureSourceSHA256": source_records,
        "normalization": "Original summary, native PNG and WGSL bytes are retained. Browser PNGs losslessly encode captured RGBA bytes. Metadata machine paths are replaced with portable placeholders and scene actor paths point to bundled meshes. Original metadata/specification SHA256 values identify capture-time bytes before normalization; verify-evidence.py validates published PNG pixels and shader/mesh/source hashes directly.",
        "validation": summary["validation"],
    }
    files = sorted(path for path in output.rglob("*") if path.is_file() and path.name != "manifest.json")
    manifest["artifacts"] = {str(path.relative_to(output)): {"sha256": digest(path), "bytes": path.stat().st_size} for path in files}
    write_json(output / "manifest.json", manifest)
    print(f"Packaged {len(files)} artifacts, {len(scenes)} native and {len(scenes)*len(variants)} browser PNGs")


if __name__ == "__main__":
    main()
