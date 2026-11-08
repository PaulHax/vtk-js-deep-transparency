# Direct local C++ VTK WebGPU comparison

Result: not pixel-perfect. Every RGBA channel is compared with zero tolerance; all eight cases fail that strict criterion.

| Dataset | Unlit differing pixels / 640,000 | PBR differing pixels / 640,000 |
| --- | ---: | ---: |
| Bonsai | 1,778 | 120,435 |
| Engine | 9,381 | 279,755 |
| Teapot | 3 | 132,210 |
| Impact | 2,204 | 153,294 |

The reference is an unmodified local build of VTK efc4afbd7430e8eddf86759c5d70711af89e50f0 using its WebGPU deep framebuffer. Native and browser renders use Vulkan and the same SwiftShader driver, identical VTP files checked by SHA-256, explicit shared camera/material/light specifications, 800 by 800 output, and one sample per pixel. Each runtime records its own adapter and attachment formats. No capture reported a rendering error or native pool exhaustion; browser actor reversal changed zero channels in every case.

All alpha channels agree. In unlit renders, Bonsai has two pixels above one color level of error, impact has one, and those three pixels lie on native color boundaries. Every other unlit mismatch is one channel level. Engine has maximum error 1; Teapot has maximum error 1. The native RGBA8 attachment and browser RGBA16F attachment provide a plausible precision explanation for the broad single-level differences, but this does not prove that all of them have that cause.

PBR differences are substantial. The two shader implementations use different diffuse-intensity, ambient, output-gamma, and Fresnel calculations even with equal public material parameters. Base IOR is explicitly 1.5 on both sides. These captures do not establish lit image parity.

The impact mesh is the same genuine yA31 cycle 21255 at 11.00054 seconds in both runtimes. It differs from the blog image at cycle 22198 and 12.00047 seconds.

Artifacts: comparison.json contains raw counts, image/specification hashes, and both runtimes’ metadata. comparison.png shows native, browser, and amplified differences. The native/ and browser/ directories contain original captures and metadata. Individual difference images and raw RGBA differences are preserved.

Reproduce with Utilities/DeepFramebufferComparison/README.md. The strict compare.py command returns exit status 1 on these results.
