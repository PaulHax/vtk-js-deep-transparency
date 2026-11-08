#!/usr/bin/env python3
"""Capture shared opaque scenes with the pinned local C++ WebGPU build."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REFERENCE = ROOT / "Data/deep-transparency/native-reference"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable",type=Path,default=ROOT/"Utilities/TestResults/pbr-isolation/native-build/capture-pbr")
    parser.add_argument(
        "--build-info",
        type=Path,
        default=DEFAULT_REFERENCE / "build-info.json",
        help="Reference build-info.json; override to reuse a build outside this checkout",
    )
    parser.add_argument("--specs",type=Path,default=ROOT/"Utilities/TestResults/pbr-isolation/specs")
    parser.add_argument("--output",type=Path,default=ROOT/"Utilities/TestResults/pbr-isolation/native")
    parser.add_argument("--cases",help="Comma-separated case names")
    args = parser.parse_args()
    build_info = json.loads(args.build_info.read_text())
    for path_key, hash_key, section in [("library","librarySHA256","dawn"),("renderingWebGPULibrary","renderingWebGPULibrarySHA256","build")]:
        record=build_info[section]
        if digest(Path(record[path_key])) != record[hash_key]:
            raise RuntimeError(f"Pinned {section} library checksum changed")
    environment={**os.environ,**build_info["runtimeEnvironment"]}
    cases=json.loads((args.specs/"index.json").read_text())["cases"]
    selected=set(args.cases.split(",")) if args.cases else None
    args.output.mkdir(parents=True,exist_ok=True)
    failures=[]
    for case in cases:
        name=case["name"]
        if selected and name not in selected: continue
        spec_path=Path(case["path"])
        spec=json.loads(spec_path.read_text())
        if spec["deepFramebuffer"] or any(actor["opacity"] != 1 for actor in spec["actors"]):
            raise RuntimeError("Controlled native capture requires opaque actors and deep framebuffer disabled")
        for actor in spec["actors"]:
            if digest(Path(actor["path"])) != actor["sha256"]: raise RuntimeError(f"{name}: mesh checksum changed")
        output_path=args.output/(name+".png")
        command=[str(args.executable),str(spec_path),str(output_path)]
        process=subprocess.run(command,env=environment,capture_output=True,text=True)
        (args.output/(name+".log")).write_text(process.stdout+process.stderr)
        if process.returncode:
            failures.append({"name":name,"returncode":process.returncode})
            print(f"{name}: failed, see native log",flush=True)
            continue
        metadata_path=output_path.with_suffix(".json")
        metadata=json.loads(metadata_path.read_text())
        metadata["specificationSHA256"]=digest(spec_path)
        metadata["referenceBuild"]=build_info
        metadata["captureExecutableSHA256"]=digest(args.executable)
        metadata["captureSourceSHA256"]=digest(ROOT/"Utilities/PBRComparison/capture.cxx")
        metadata["captureImageSHA256"]=digest(output_path)
        metadata_path.write_text(json.dumps(metadata,indent=2)+"\n")
        if metadata["errors"] or metadata["deepFramebufferEnabled"]:
            failures.append({"name":name,"errors":metadata["errors"],"deepFramebufferEnabled":metadata["deepFramebufferEnabled"]})
        print(f"{name}: opaque captured",flush=True)
    (args.output/"capture-status.json").write_text(json.dumps({"failures":failures},indent=2)+"\n")
    if failures: raise SystemExit(1)


if __name__ == "__main__": main()
