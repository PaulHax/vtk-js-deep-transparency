#!/usr/bin/env python3
"""Measure opaque PBR captures with strict full-image and diagnostic interior metrics.

Every RGBA channel participates in the strict comparison. Interior metrics are
additional diagnostics and never remove a full-image mismatch or imply parity.
Browser readbacks are top-to-bottom RGBA, as in the saved deep comparison.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CAPTURES = ROOT / "Utilities/TestResults/pbr-isolation"
VARIANTS = ["baseline", "output", "diffuse", "ambient", "visibility", "fresnel",
            "output-diffuse", "output-diffuse-ambient", "output-diffuse-ambient-visibility",
            "cpp-equations", "cpp-equations-view", "light", "output-light",
            "output-light-diffuse", "output-light-diffuse-ambient",
            "output-light-diffuse-ambient-visibility", "output-light-diffuse-ambient-visibility-fresnel",
            "cpp-equations-float-normals", "cpp-equations-view-float-normals"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def browser_array(path, spec):
    raw = path.read_bytes()
    expected = spec["width"] * spec["height"] * 4
    if len(raw) != expected:
        raise RuntimeError(f"{path}: expected {expected} bytes, found {len(raw)}")
    return np.frombuffer(raw, dtype=np.uint8).reshape(spec["height"], spec["width"], 4)


def erode(mask, radius=2):
    padded = np.pad(mask, radius, constant_values=False)
    result = np.ones(mask.shape, dtype=bool)
    for y in range(2 * radius + 1):
        for x in range(2 * radius + 1):
            result &= padded[y:y+mask.shape[0], x:x+mask.shape[1]]
    return result


def metrics(native, browser, mask=None):
    a = native if mask is None else native[mask]
    b = browser if mask is None else browser[mask]
    if a.size == 0:
        return None
    delta = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return {
        "totalPixels": int(np.prod(a.shape[:-1])),
        "pixelPerfect": not bool(np.any(delta)),
        "differingRGBAPixels": int(np.count_nonzero(np.any(delta != 0, axis=-1))),
        "differingRGBPixels": int(np.count_nonzero(np.any(delta[..., :3] != 0, axis=-1))),
        "differingChannels": int(np.count_nonzero(delta)),
        "differingAlphaPixels": int(np.count_nonzero(delta[..., 3])),
        "maximumRGBAError": int(delta.max()),
        "maximumErrorPerChannel": np.max(delta.reshape(-1,4), axis=0).astype(int).tolist(),
        "meanAbsoluteRGBError": float(delta[..., :3].mean()),
        "rootMeanSquareRGBError": float(np.sqrt(np.mean(delta[..., :3].astype(float) ** 2))),
    }



def plane_equation_predictions(spec):
    """Ideal float64 center evaluation for this harness's constant-normal plane.

    This follows the inspected source equations and public scene specification.
    It excludes f32 arithmetic, intermediate half-float storage, and raster effects.
    """
    color = np.asarray(spec["actors"][0]["color"], dtype=float)
    material = spec["material"]
    if spec["mode"] == "unlit":
        cpp = (material["ambient"]+material["diffuse"])*color
        js = color
    else:
        width, height = spec["width"], spec["height"]
        distance = spec["camera"]["position"][2]
        scale = distance * math.tan(math.radians(spec["camera"]["viewAngle"])/2)
        x = (2*(width//2+.5)/width-1)*scale*(width/height)
        y = (1-2*(height//2+.5)/height)*scale
        view = np.asarray([-x,-y,distance], dtype=float)
        view /= np.linalg.norm(view)
        cpp = np.zeros(3); js = material["ambient"]*color*color
        roughness, metallic = material["roughness"], material["metallic"]
        f0_dielectric = ((material["baseIOR"]-1)/(material["baseIOR"]+1))**2
        def schlick(f0,f90,hdL):
            return f0 + (f90-f0)*(1-hdL)**5
        for light in spec["lights"]:
            if light["positional"]:
                raise RuntimeError("Plane analytic fixture requires a directional light")
            direction=np.asarray(light["position"],dtype=float)-np.asarray(light["focalPoint"],dtype=float)
            direction/=np.linalg.norm(direction)
            half=view+direction; half/=np.linalg.norm(half)
            ndV=max(view[2],1e-5); ndL=max(direction[2],1e-5); ndH=max(half[2],1e-5)
            hdL=max(float(np.dot(half,direction)),1e-5)
            a2=roughness**4
            denom=(ndH*a2-ndH)*ndH+1
            cppD=a2/max(math.pi*denom*denom,1e-8)
            jsD=a2/max(math.pi*((ndH*ndH)*(a2-1)+1)**2,1e-6)
            def visibility(a2):
                return .5/(ndL*math.sqrt(a2+ndV*(ndV-a2*ndV))+ndV*math.sqrt(a2+ndL*(ndL-a2*ndL)))
            cpp_albedo=material["diffuse"]*color
            cpp_f0=(1-metallic)*f0_dielectric+metallic*cpp_albedo
            cpp_f90=(1-metallic)*np.clip(np.dot(cpp_f0,np.asarray([16.5]*3)),0,1)+metallic
            cpp_f=schlick(cpp_f0,cpp_f90,hdL)
            incoming=np.asarray(light["color"],dtype=float)*light["intensity"]
            cpp+=incoming*ndL*((1-metallic)*(1-cpp_f)*cpp_albedo/math.pi+cppD*visibility(roughness**2)*cpp_f)
            dielectric_f=schlick(f0_dielectric,1,hdL)
            metal_f=schlick(color,1,hdL)
            js_specular=jsD*visibility(roughness**4)
            js+=incoming*5*ndL*((1-metallic)*((1-dielectric_f)*color/math.pi+dielectric_f*js_specular)+metallic*metal_f*js_specular)
        cpp=np.maximum(cpp,0)**(1/2.2)
    return {"nativeOutputRGBFloat255":(np.clip(cpp,0,1)*255).tolist(),
            "baselineBrowserOutputRGBFloat255":(np.clip(js,0,1)*255).tolist(),
            "note":"Ideal center sample from inspected equations, excluding f32/half-float storage and quantization differences"}


def validate(spec_path, spec, native_meta, browser_meta, variant):
    expected = digest(spec_path)
    for runtime, meta in [("native", native_meta), ("browser", browser_meta)]:
        if meta.get("specificationSHA256") != expected:
            raise RuntimeError(f"{spec['name']}/{variant}: {runtime} specification checksum mismatch")
        if meta.get("errors") or meta.get("gpuErrors"):
            raise RuntimeError(f"{spec['name']}/{variant}: {runtime} rendering error")
        if meta.get("deepFramebufferEnabled") is not False:
            raise RuntimeError(f"{spec['name']}/{variant}: {runtime} deep framebuffer is not disabled")
    if native_meta.get("samplesPerPixel") != 1 or browser_meta.get("sampleCount") != 1:
        raise RuntimeError(f"{spec['name']}/{variant}: samples per pixel differ from one")
    if browser_meta.get("variant") != variant:
        raise RuntimeError(f"{spec['name']}/{variant}: browser variant metadata mismatch")
    if "float-normals" in variant and browser_meta.get("bufferDiagnostics", {}).get("normalOverrides", 0) < 1:
        raise RuntimeError(f"{spec['name']}/{variant}: no float-normal buffer override recorded")
    for i, actor in enumerate(spec["actors"]):
        if actor["opacity"] != 1 or digest(Path(actor["path"])) != actor["sha256"]:
            raise RuntimeError(f"{spec['name']}: input mesh changed or actor is not opaque")
        if native_meta["geometry"][i]["sha256"] != actor["sha256"]:
            raise RuntimeError(f"{spec['name']}: native mesh provenance mismatch")
        js_geometry = browser_meta["geometry"][i]
        if js_geometry["points"] != actor["pointCount"] or js_geometry["polygons"] != actor["triangleCount"]:
            raise RuntimeError(f"{spec['name']}: browser mesh counts differ")
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--specs", type=Path)
    parser.add_argument("--cases", help="Comma-separated case names")
    parser.add_argument("--variants", default=",".join(VARIANTS))
    args = parser.parse_args()
    captures = args.captures
    specs = args.specs or captures / "specs"
    selected = set(args.cases.split(",")) if args.cases else None
    variants = args.variants.split(",")
    index = read_json(specs / "index.json")
    analysis = captures / "analysis"
    analysis.mkdir(parents=True, exist_ok=True)
    results, panels, input_hashes = [], [], {}
    for entry in index["cases"]:
        name = entry["name"]
        if selected and name not in selected:
            continue
        spec_path = Path(entry.get("path", specs / (name + ".json")))
        spec = read_json(spec_path)
        native_path = captures / "native" / (name + ".png")
        native = np.asarray(Image.open(native_path).convert("RGBA"))
        if native.shape != (spec["height"], spec["width"], 4):
            raise RuntimeError(f"{name}: native image dimensions differ")
        native_meta = read_json(native_path.with_suffix(".json"))
        browsers = {v: browser_array(captures / "browser" / v / (name + ".rgba"), spec) for v in variants}
        final_name = next(v for v in ["cpp-equations-view-float-normals", "cpp-equations-float-normals", "cpp-equations-view", "cpp-equations", variants[-1]] if v in browsers)
        final = browsers[final_name]
        # Shared nonblack pixels are a lighting-dependent diagnostic subset.
        # The two-pixel erosion excludes coverage boundaries, not full-image errors.
        mask = erode(np.any(native[..., :3] != 0,axis=2) & np.any(final[..., :3] != 0,axis=2))
        mask_file = name + "-interior-mask.png"
        Image.fromarray(mask.astype(np.uint8)*255).save(analysis / mask_file)
        center_y, center_x = spec["height"] // 2, spec["width"] // 2
        center_slice = (slice(center_y-4, center_y+4),slice(center_x-4,center_x+4))
        case = {
            "name": name, "mode": spec["mode"], "material": spec["material"],
            "parallelProjection": spec["camera"]["parallelProjection"],
            "specificationSHA256": digest(spec_path),
            "meshSHA256": [a["sha256"] for a in spec["actors"]],
            "nativeImageSHA256": digest(native_path),
            "nativeFormat": native_meta["offscreenColorFormat"],
            "nativeCenterPixelRGBA": native[center_y,center_x].astype(int).tolist(),
            "nativeCenter8x8MeanRGB": native[center_slice][..., :3].mean(axis=(0,1)).tolist(),
            "interiorMask": {"file": mask_file, "pixelCount":int(mask.sum()),
                "selection":"native and final browser nonblack RGB intersection, eroded two pixels in all directions",
                "finalVariant": final_name,
                "limitation":"Lighting-dependent subset; empty for black fixtures. Strict full-image metrics always retained."},
            "variants": {},
        }
        if name.startswith("plane-"):
            case["idealPlaneCenterPrediction"] = plane_equation_predictions(spec)
        baseline = browsers.get("baseline")
        for variant, browser in browsers.items():
            raw_path = captures / "browser" / variant / (name + ".rgba")
            browser_meta = read_json(raw_path.with_suffix(".json"))
            validate(spec_path, spec, native_meta, browser_meta, variant)
            if browser_meta.get("captureRGBASHA256") and browser_meta["captureRGBASHA256"] != digest(raw_path):
                raise RuntimeError(f"{name}/{variant}: browser RGBA checksum mismatch")
            if native_meta.get("captureImageSHA256") and native_meta["captureImageSHA256"] != digest(native_path):
                raise RuntimeError(f"{name}: native image checksum mismatch")
            for shader in browser_meta.get("shaders", []):
                if digest(raw_path.parent / shader["file"]) != shader["sha256"]:
                    raise RuntimeError(f"{name}/{variant}: shader checksum mismatch")
            Image.fromarray(browser).save(raw_path.with_suffix(".png"))
            delta = np.abs(native.astype(np.int16)-browser.astype(np.int16)).astype(np.uint8)
            target = analysis / variant
            target.mkdir(exist_ok=True)
            (target/(name+"-absolute-difference.rgba")).write_bytes(delta.tobytes())
            Image.fromarray(delta[..., :3]).save(target/(name+"-absolute-difference.png"))
            Image.fromarray(delta[..., 3]).save(target/(name+"-alpha-difference.png"))
            amplified = np.minimum(delta[..., :3].astype(np.int16)*8,255).astype(np.uint8)
            Image.fromarray(amplified).save(target/(name+"-difference-x8.png"))
            case["variants"][variant] = {
                "fullImage": metrics(native,browser), "interior": metrics(native,browser,mask),
                "centerPixelRGBA": browser[center_y,center_x].astype(int).tolist(),
                "center8x8MeanRGB":browser[center_slice][..., :3].mean(axis=(0,1)).tolist(),
                "changeFromBaseline": metrics(baseline,browser) if baseline is not None else None,
                "rawSHA256":digest(raw_path), "metadataSHA256":digest(raw_path.with_suffix(".json")),
                "colorAttachmentFormat":browser_meta["colorAttachmentFormat"],
                "presentationFormat":browser_meta["presentationFormat"],
                "shaderSHA256":[shader["sha256"] for shader in browser_meta.get("shaders",[])],
                "bufferDiagnostics": browser_meta.get("bufferDiagnostics"),
            }
        results.append(case)
        input_hashes[name] = {"nativeMetadataSHA256":digest(native_path.with_suffix(".json")),"specificationSHA256":digest(spec_path)}
        print(name + ": " + "; ".join(v+" MAE="+format(case["variants"][v]["fullImage"]["meanAbsoluteRGBError"],".6f") for v in variants), flush=True)
        if name in ["plane-diffuse-0","plane-diffuse-1","plane-ambient-05","plane-unlit","sphere-base","sphere-metallic-05","sphere-roughness-01","sphere-metallic-roughness-01","sphere-ortho"]:
            display_variants = [v for v in ["baseline","output-light","output-light-diffuse","cpp-equations",final_name] if v in browsers]
            columns = [("C++",native)] + [(v,browsers[v]) for v in display_variants]
            v = final_name
            diff = np.minimum(np.abs(native[..., :3].astype(np.int16)-browsers[v][..., :3].astype(np.int16))*8,255).astype(np.uint8)
            columns.append((v+" abs diff x8",diff))
            tile_width,tile_height = 256, 292
            panel = Image.new("RGB",(len(columns)*tile_width,tile_height),(20,24,30))
            draw = ImageDraw.Draw(panel)
            for i,(label,array) in enumerate(columns):
                draw.text((i*tile_width+5,3),name if i == 0 else label,fill="white")
                if i == 0: draw.text((5,17),label,fill="white")
                panel.paste(Image.fromarray(array).convert("RGB"),(i*tile_width,36))
            panels.append(panel)
    if not results:
        raise RuntimeError("No selected captures")
    summary = {
        "criterion":"All full-image RGBA channels equal, zero tolerance; diagnostic interior does not change criterion",
        "rgbErrorUnits":"8-bit output channel levels (0..255)",
        "orientation":"Both native PNG and browser RGBA are top-to-bottom; no registration or spatial allowance",
        "variants":variants,"inputProvenance":input_hashes,"results":results,
        "validation":"Every capture checked for one sample, deep disabled, empty error lists, matching specification and mesh checksums/counts, and shader-file checksums",
    }
    (analysis/"summary.json").write_text(json.dumps(summary,indent=2)+"\n")
    if panels:
        contact = Image.new("RGB",(max(p.width for p in panels),sum(p.height for p in panels)),(20,24,30))
        y=0
        for panel in panels:
            contact.paste(panel,(0,y)); y += panel.height
        contact.save(analysis/"comparison.png")
    lines = ["Opaque PBR captures; full-image RGB errors in 8-bit channel levels.","Strict full-image RGBA criterion is retained. Interior metrics are additional diagnostics.",""]
    for case in results:
        available=case["variants"]
        final_name=case["interiorMask"]["finalVariant"]
        selected_variants=[v for v in ["baseline","output-light","output-light-diffuse","output-light-diffuse-ambient-visibility-fresnel",final_name] if v in available]
        measures="; ".join(v+"="+format(available[v]["fullImage"]["meanAbsoluteRGBError"],".6f") for v in selected_variants)
        final=available[final_name]["fullImage"]
        lines.append(case["name"]+": "+measures+"; final RGBA differing="+str(final["differingRGBAPixels"])+", max="+str(final["maximumRGBAError"])+", alpha="+str(final["differingAlphaPixels"]))
    (analysis/"findings.txt").write_text("\n".join(lines)+"\n")
    print("Saved "+str(analysis/"summary.json"),flush=True)


if __name__ == "__main__":
    main()
