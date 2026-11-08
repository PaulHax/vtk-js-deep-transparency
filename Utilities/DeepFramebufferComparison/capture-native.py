#!/usr/bin/env python3
"""Render the shared blog-dataset specifications with the local C++ executable."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = ROOT / "Data/deep-transparency/native-reference"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, default=REFERENCE / "capture-build/capture-deep-framebuffer")
    parser.add_argument("--build-info", type=Path, default=REFERENCE / "build-info.json")
    parser.add_argument("--specs", type=Path, default=ROOT / "Data/deep-transparency/comparison/specs")
    parser.add_argument("--output", type=Path, default=ROOT / "Utilities/TestResults/deep-transparency/native-webgpu/native")
    parser.add_argument("--cases", help="Comma-separated case names")
    args = parser.parse_args()
    build_info = json.loads(args.build_info.read_text())
    environment = {**os.environ, **build_info["runtimeEnvironment"]}
    cases = json.loads((args.specs / "index.json").read_text())["cases"]
    selected = set(args.cases.split(",")) if args.cases else None
    args.output.mkdir(parents=True, exist_ok=True)
    failures = []
    for case in cases:
        name = case["name"]
        if selected and name not in selected:
            continue
        spec_path = Path(case.get("path", args.specs / f"{name}.json"))
        spec = json.loads(spec_path.read_text())
        for actor in spec["actors"]:
            if digest(Path(actor["path"])) != actor["sha256"]:
                raise RuntimeError(f"{name}: input mesh hash mismatch")
        output_path = args.output / f"{name}.png"
        command = [str(args.executable), str(spec_path), str(output_path)]
        process = subprocess.run(command, env=environment, capture_output=True, text=True)
        (args.output / f"{name}.log").write_text(process.stdout + process.stderr)
        if process.returncode:
            failures.append({"name": name, "returncode": process.returncode})
            print(f"{name}: capture failed; see {name}.log", flush=True)
            continue
        metadata_path = output_path.with_suffix(".json")
        metadata = json.loads(metadata_path.read_text())
        metadata["specificationSHA256"] = digest(spec_path)
        metadata["referenceBuild"] = build_info
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
        if metadata.get("errors") or metadata.get("sharedPoolExhausted"):
            failures.append({"name": name, "errors": metadata.get("errors"), "sharedPoolExhausted": metadata.get("sharedPoolExhausted")})
        print(f"{name}: captured, requests={metadata.get('fragmentRequests')}, capacity={metadata.get('fragmentCapacity')}, exhausted={metadata.get('sharedPoolExhausted')}", flush=True)
    (args.output / "capture-status.json").write_text(json.dumps({"failures": failures}, indent=2) + "\n")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
