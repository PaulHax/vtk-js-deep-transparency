cmake_minimum_required(VERSION 3.16)
project(PBRComparison LANGUAGES CXX)

find_package(VTK REQUIRED COMPONENTS
  CommonCore
  CommonDataModel
  IOImage
  IOXML
  RenderingCore
  RenderingWebGPU
  jsoncpp
)

add_executable(capture-pbr capture.cxx)
target_compile_features(capture-pbr PRIVATE cxx_std_17)
target_link_libraries(capture-pbr PRIVATE ${VTK_LIBRARIES})
set(DEEP_FRAMEBUFFER_WEBGPU_LIBRARY "" CACHE FILEPATH "The same WebGPU runtime loaded by VTK")
if(NOT EXISTS "${DEEP_FRAMEBUFFER_WEBGPU_LIBRARY}")
  message(FATAL_ERROR "Set DEEP_FRAMEBUFFER_WEBGPU_LIBRARY to the pinned Dawn shared library")
endif()
target_link_libraries(capture-pbr PRIVATE "${DEEP_FRAMEBUFFER_WEBGPU_LIBRARY}")
vtk_module_autoinit(TARGETS capture-pbr MODULES ${VTK_LIBRARIES})
set(DEEP_FRAMEBUFFER_REFERENCE_REVISION "unknown" CACHE STRING "Pinned VTK source revision")
target_compile_definitions(capture-pbr PRIVATE
  DEEP_FRAMEBUFFER_REFERENCE_REVISION="${DEEP_FRAMEBUFFER_REFERENCE_REVISION}"
  DEEP_FRAMEBUFFER_WEBGPU_LIBRARY="${DEEP_FRAMEBUFFER_WEBGPU_LIBRARY}")
