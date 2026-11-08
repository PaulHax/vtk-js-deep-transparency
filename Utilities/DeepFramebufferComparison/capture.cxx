#include "vtkActor.h"
#include "vtkCamera.h"
#include "vtkImageData.h"
#include "vtkLight.h"
#include "vtkNew.h"
#include "vtkObjectFactory.h"
#include "vtkOutputWindow.h"
#include "vtkPNGWriter.h"
#include "vtkPolyData.h"
#include "vtkPolyDataMapper.h"
#include "vtkProperty.h"
#include "vtkSmartPointer.h"
#include "vtkVersion.h"
#include "vtkWebGPUConfiguration.h"
#include "vtkWebGPUDeepFramebuffer.h"
#include "vtkWebGPURenderer.h"
#include "vtkWebGPURenderWindow.h"
#include "vtkWindowToImageFilter.h"
#include "vtkXMLPolyDataReader.h"
#include "vtk_jsoncpp.h"
#include "vtk_wgpu.h"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
class ErrorOutput : public vtkOutputWindow
{
public:
  static ErrorOutput* New() { return new ErrorOutput; }
  vtkTypeMacro(ErrorOutput, vtkOutputWindow);
  std::vector<std::string> Errors;
  void DisplayErrorText(const char* text) override
  {
    this->Errors.emplace_back(text);
    this->Superclass::DisplayErrorText(text);
  }
};

std::array<double, 3> Triple(const Json::Value& value)
{
  if (!value.isArray() || value.size() != 3)
  {
    throw std::runtime_error("Expected a three-component JSON array");
  }
  return { value[0].asDouble(), value[1].asDouble(), value[2].asDouble() };
}

std::string TextureFormat(WGPUTextureFormat format)
{
  switch (format)
  {
    case WGPUTextureFormat_RGBA8Unorm: return "rgba8unorm";
    case WGPUTextureFormat_BGRA8Unorm: return "bgra8unorm";
    case WGPUTextureFormat_RGBA16Float: return "rgba16float";
    case WGPUTextureFormat_Depth24PlusStencil8: return "depth24plus-stencil8";
    case WGPUTextureFormat_Depth32Float: return "depth32float";
    default: return "WebGPU texture format " + std::to_string(static_cast<int>(format));
  }
}

std::array<std::uint32_t, 4> FragmentStatistics(
  vtkWebGPUConfiguration* configuration, vtkWebGPUDeepFramebuffer* deep)
{
  constexpr const char* source = R"(
struct Node { color:u32, depth:f32, cell:u32, prop:u32, composite:u32, process:u32, next:u32 };
@group(0) @binding(0) var<storage,read_write> counter:atomic<u32>;
@group(0) @binding(1) var<storage,read_write> heads:array<atomic<u32>>;
@group(0) @binding(2) var<storage,read> nodes:array<Node>;
@group(0) @binding(3) var<storage,read_write> stats:array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
  if (id.x == 0u) { atomicStore(&stats[0], atomicLoad(&counter)); }
  if (id.x >= arrayLength(&heads)) { return; }
  var node = atomicLoad(&heads[id.x]);
  var length = 0u;
  loop {
    if (node == 0xFFFFFFFFu || node >= arrayLength(&nodes) || length >= 4096u) { break; }
    length += 1u;
    node = nodes[node].next;
  }
  atomicMax(&stats[1], length);
  if (length > 16u) { atomicAdd(&stats[2], 1u); }
  atomicAdd(&stats[3], length);
})";
  const WGPUDevice device = configuration->GetDevice();
  WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
  wgsl.code = { source, WGPU_STRLEN };
  WGPUShaderModuleDescriptor shaderDescription = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
  shaderDescription.nextInChain = &wgsl.chain;
  const WGPUShaderModule shader = wgpuDeviceCreateShaderModule(device, &shaderDescription);
  WGPUComputePipelineDescriptor pipelineDescription = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
  pipelineDescription.compute.module = shader;
  pipelineDescription.compute.entryPoint = { "main", WGPU_STRLEN };
  const WGPUComputePipeline pipeline = wgpuDeviceCreateComputePipeline(device, &pipelineDescription);
  const WGPUBindGroupLayout layout = wgpuComputePipelineGetBindGroupLayout(pipeline, 0);
  const WGPUBuffer statistics = configuration->CreateBuffer(16,
    WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst, false, "Fragment statistics");
  const WGPUBuffer readback = configuration->CreateBuffer(16,
    WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst, false, "Fragment statistics readback");
  const WGPUQueue queue = wgpuDeviceGetQueue(device);
  std::array<std::uint32_t, 4> result{};
  wgpuQueueWriteBuffer(queue, statistics, 0, result.data(), sizeof(result));
  const WGPUBuffer buffers[] = { deep->GetFragmentCounterBuffer(), deep->GetHeadPointersBuffer(),
    deep->GetFragmentNodesBuffer(), statistics };
  const std::uint64_t sizes[] = { 4, 4ull * deep->GetWidth() * deep->GetHeight(),
    28ull * deep->GetFragmentNodeCapacity(), 16 };
  WGPUBindGroupEntry entries[4];
  for (unsigned i = 0; i < 4; ++i)
  {
    entries[i] = WGPU_BIND_GROUP_ENTRY_INIT;
    entries[i].binding = i;
    entries[i].buffer = buffers[i];
    entries[i].size = sizes[i];
  }
  WGPUBindGroupDescriptor groupDescription = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
  groupDescription.layout = layout;
  groupDescription.entryCount = 4;
  groupDescription.entries = entries;
  const WGPUBindGroup group = wgpuDeviceCreateBindGroup(device, &groupDescription);
  const WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, nullptr);
  const WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, nullptr);
  wgpuComputePassEncoderSetPipeline(pass, pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass,
    (deep->GetWidth() * deep->GetHeight() + 63) / 64, 1, 1);
  wgpuComputePassEncoderEnd(pass);
  wgpuCommandEncoderCopyBufferToBuffer(encoder, statistics, 0, readback, 0, sizeof(result));
  const WGPUCommandBuffer command = wgpuCommandEncoderFinish(encoder, nullptr);
  wgpuQueueSubmit(queue, 1, &command);
  struct MapState { bool Done = false; bool Success = false; } state;
  WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
  callback.mode = WGPUCallbackMode_AllowProcessEvents;
  callback.userdata1 = &state;
  callback.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* data, void*) {
    auto* map = static_cast<MapState*>(data);
    map->Success = status == WGPUMapAsyncStatus_Success;
    map->Done = true;
  };
  wgpuBufferMapAsync(readback, WGPUMapMode_Read, 0, sizeof(result), callback);
  while (!state.Done) configuration->ProcessEvents();
  if (!state.Success) throw std::runtime_error("Native fragment statistics readback failed");
  std::memcpy(result.data(), wgpuBufferGetConstMappedRange(readback, 0, sizeof(result)), sizeof(result));
  wgpuBufferUnmap(readback);
  wgpuCommandBufferRelease(command);
  wgpuCommandEncoderRelease(encoder);
  wgpuComputePassEncoderRelease(pass);
  wgpuBindGroupRelease(group);
  wgpuBindGroupLayoutRelease(layout);
  wgpuComputePipelineRelease(pipeline);
  wgpuShaderModuleRelease(shader);
  wgpuBufferRelease(statistics);
  wgpuBufferRelease(readback);
  wgpuQueueRelease(queue);
  return result;
}
}

int main(int argc, char** argv)
{
  try
  {
    if (argc != 3)
      throw std::runtime_error("Usage: capture-deep-framebuffer specification.json output.png");
    const std::filesystem::path specificationPath = std::filesystem::absolute(argv[1]);
    const std::filesystem::path outputPath = std::filesystem::absolute(argv[2]);
    Json::Value specification;
    std::ifstream input(specificationPath);
    Json::CharReaderBuilder readerBuilder;
    std::string parseErrors;
    if (!Json::parseFromStream(readerBuilder, input, &specification, &parseErrors))
      throw std::runtime_error("Invalid scene specification: " + parseErrors);
    const std::string mode = specification["mode"].asString();
    if (mode != "unlit" && mode != "pbr") throw std::runtime_error("Expected unlit or pbr mode");
    if (specification["multiSample"].asInt() != 1)
      throw std::runtime_error("The native reference supports one sample per pixel");
    const char* runtime = std::getenv("VTK_WEBGPU_LIBRARY");
    if (!runtime || std::filesystem::canonical(runtime) !=
        std::filesystem::canonical(DEEP_FRAMEBUFFER_WEBGPU_LIBRARY))
      throw std::runtime_error("VTK and capture diagnostics must use the same WebGPU runtime");

    vtkNew<ErrorOutput> errors;
    vtkOutputWindow::SetInstance(errors);
    vtkObjectFactory::SetPreferences("RenderingBackend=WebGPU");
    vtkNew<vtkWebGPUConfiguration> configuration;
    configuration->SetBackend(vtkWebGPUConfiguration::BackendType::Vulkan);
    if (!configuration->Initialize()) throw std::runtime_error("Native WebGPU initialization failed");
    vtkNew<vtkWebGPURenderWindow> window;
    window->SetWGPUConfiguration(configuration);
    window->SetShowWindow(false);
    window->SetUseOffScreenBuffers(true);
    window->SetMultiSamples(0);
    window->SetAlphaBitPlanes(1);
    window->SetSize(specification["width"].asInt(), specification["height"].asInt());
    vtkNew<vtkWebGPURenderer> renderer;
    renderer->UseRenderBundlesOff();
    renderer->UseDeepFramebufferTransparencyOn();
    renderer->UseFXAAOff();
    renderer->AutomaticLightCreationOff();
    renderer->UseImageBasedLightingOff();
    renderer->SetBackground(Triple(specification["background"]).data());
    renderer->SetBackgroundAlpha(specification.get("backgroundAlpha", 1).asDouble());
    window->AddRenderer(renderer);

    for (const auto& entry : specification["lights"])
    {
      vtkNew<vtkLight> light;
      light->SetLightTypeToSceneLight();
      light->SetPosition(Triple(entry["position"]).data());
      light->SetFocalPoint(Triple(entry["focalPoint"]).data());
      light->SetColor(Triple(entry["color"]).data());
      light->SetIntensity(entry["intensity"].asDouble());
      light->SetPositional(entry["positional"].asBool());
      renderer->AddLight(light);
    }
    Json::Value geometry(Json::arrayValue);
    const auto& material = specification["material"];
    for (const auto& entry : specification["actors"])
    {
      vtkNew<vtkXMLPolyDataReader> meshReader;
      meshReader->SetFileName(entry["path"].asCString());
      meshReader->Update();
      auto* mesh = meshReader->GetOutput();
      if (mesh->GetNumberOfPoints() != entry["pointCount"].asInt64() ||
          mesh->GetNumberOfPolys() != entry["triangleCount"].asInt64())
        throw std::runtime_error("Native mesh counts differ from specification");
      vtkNew<vtkPolyDataMapper> mapper;
      if (!mapper->IsA("vtkWebGPUPolyDataMapper"))
        throw std::runtime_error("The native mapper did not select its WebGPU implementation");
      mapper->SetInputData(mesh);
      mapper->ScalarVisibilityOff();
      vtkNew<vtkActor> actor;
      actor->SetMapper(mapper);
      auto* property = actor->GetProperty();
      property->SetColor(Triple(entry["color"]).data());
      property->SetOpacity(entry["opacity"].asDouble());
      property->SetAmbient(material["ambient"].asDouble());
      property->SetDiffuse(material["diffuse"].asDouble());
      property->SetSpecular(material["specular"].asDouble());
      property->SetSpecularPower(material["specularPower"].asDouble());
      property->SetMetallic(material["metallic"].asDouble());
      property->SetRoughness(material["roughness"].asDouble());
      property->SetBaseIOR(material.get("baseIOR", 1.5).asDouble());
      property->SetLighting(mode == "pbr");
      if (mode == "pbr") property->SetInterpolationToPBR();
      else property->SetInterpolationToPhong();
      renderer->AddActor(actor);
      Json::Value record;
      record["mapperClass"] = mapper->GetClassName();
      record["actorClass"] = actor->GetClassName();
      record["propertyClass"] = property->GetClassName();
      record["points"] = Json::Int64(mesh->GetNumberOfPoints());
      record["triangles"] = Json::Int64(mesh->GetNumberOfPolys());
      record["sha256"] = entry["sha256"];
      geometry.append(record);
    }
    auto* camera = renderer->GetActiveCamera();
    const auto& cameraSpec = specification["camera"];
    camera->SetPosition(Triple(cameraSpec["position"]).data());
    camera->SetFocalPoint(Triple(cameraSpec["focalPoint"]).data());
    camera->SetViewUp(Triple(cameraSpec["viewUp"]).data());
    camera->SetParallelProjection(cameraSpec["parallelProjection"].asBool());
    camera->SetParallelScale(cameraSpec["parallelScale"].asDouble());
    camera->SetViewAngle(cameraSpec["viewAngle"].asDouble());
    camera->SetClippingRange(cameraSpec["clippingRange"][0].asDouble(),
      cameraSpec["clippingRange"][1].asDouble());

    // The pool is allocated lazily; release it after configuration to apply its budget.
    window->Render();
    window->WaitForCompletion();
    auto* deep = renderer->GetDeepFramebuffer();
    if (!deep || !renderer->GetUseDeepFramebufferTransparency())
      throw std::runtime_error("Native renderer did not activate the deep framebuffer");
    deep->SetAverageLayersPerPixel(specification["poolLayers"].asUInt());
    deep->ReleaseGraphicsResources();
    window->Render();
    window->WaitForCompletion();
    if (!renderer->GetUseDeepFramebufferTransparency() || deep->GetFragmentNodeCapacity() == 0)
      throw std::runtime_error("Native deep framebuffer allocation failed");

    vtkNew<vtkWindowToImageFilter> capture;
    capture->SetInput(window);
    capture->SetInputBufferTypeToRGBA();
    capture->ReadFrontBufferOff();
    capture->ShouldRerenderOff();
    capture->Update();
    if (capture->GetOutput()->GetNumberOfScalarComponents() != 4)
      throw std::runtime_error("Native capture did not return RGBA");
    std::filesystem::create_directories(outputPath.parent_path());
    vtkNew<vtkPNGWriter> writer;
    writer->SetFileName(outputPath.string().c_str());
    writer->SetInputConnection(capture->GetOutputPort());
    writer->Write();
    const auto statistics = FragmentStatistics(configuration, deep);

    Json::Value metadata;
    metadata["name"] = specification["name"];
    metadata["mode"] = mode;
    metadata["backend"] = "C++ VTK WebGPU deep framebuffer";
    metadata["renderWindowClass"] = window->GetClassName();
    metadata["rendererClass"] = renderer->GetClassName();
    metadata["deepFramebufferClass"] = deep->GetClassName();
    metadata["vtkVersion"] = vtkVersion::GetVTKVersion();
    metadata["vtkRevision"] = DEEP_FRAMEBUFFER_REFERENCE_REVISION;
    metadata["runtimeBackend"] = configuration->GetBackendInUseAsString();
    metadata["runtimeLibrary"] = std::getenv("VTK_WEBGPU_LIBRARY") ? std::getenv("VTK_WEBGPU_LIBRARY") : "default";
    metadata["vulkanICD"] = std::getenv("VK_ICD_FILENAMES") ? std::getenv("VK_ICD_FILENAMES") : "default";
    metadata["adapterCapabilities"] = configuration->ReportCapabilities();
    metadata["offscreenColorFormat"] = TextureFormat(window->GetOffscreenColorTextureFormat());
    metadata["depthStencilFormat"] = TextureFormat(window->GetDepthStencilFormat());
    metadata["width"] = specification["width"];
    metadata["height"] = specification["height"];
    metadata["samplesPerPixel"] = 1;
    metadata["captureComponents"] = 4;
    metadata["specificationPath"] = specificationPath.string();
    metadata["specification"] = specification;
    metadata["geometry"] = geometry;
    metadata["poolLayers"] = deep->GetAverageLayersPerPixel();
    metadata["fragmentCapacity"] = deep->GetFragmentNodeCapacity();
    metadata["fragmentRequests"] = statistics[0];
    metadata["maximumListLength"] = statistics[1];
    metadata["pixelsOverSixteenLayers"] = statistics[2];
    metadata["retainedFragments"] = statistics[3];
    metadata["sharedPoolExhausted"] = statistics[0] > deep->GetFragmentNodeCapacity();
    metadata["errors"] = Json::Value(Json::arrayValue);
    for (const auto& error : errors->Errors) metadata["errors"].append(error);
    const auto metadataPath = outputPath.parent_path() / (outputPath.stem().string() + ".json");
    std::ofstream metadataFile(metadataPath);
    Json::StreamWriterBuilder writerBuilder;
    writerBuilder["indentation"] = "  ";
    metadataFile << Json::writeString(writerBuilder, metadata) << '\n';
    window->Finalize();
    if (!errors->Errors.empty()) throw std::runtime_error("Native capture reported VTK or WebGPU errors");
    std::cout << outputPath << '\n';
    return EXIT_SUCCESS;
  }
  catch (const std::exception& error)
  {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
