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


}

int main(int argc, char** argv)
{
  try
  {
    if (argc != 3)
      throw std::runtime_error("Usage: capture-pbr specification.json output.png");
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
    renderer->UseDeepFramebufferTransparencyOff();
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

    window->Render();
    window->WaitForCompletion();
    if (renderer->GetUseDeepFramebufferTransparency())
      throw std::runtime_error("Controlled opaque capture must disable deep transparency");

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

    Json::Value metadata;
    metadata["name"] = specification["name"];
    metadata["mode"] = mode;
    metadata["backend"] = "C++ VTK WebGPU opaque";
    metadata["renderWindowClass"] = window->GetClassName();
    metadata["rendererClass"] = renderer->GetClassName();
    metadata["deepFramebufferEnabled"] = renderer->GetUseDeepFramebufferTransparency();
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
