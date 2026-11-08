import { Nullable } from '../../../types';
import {
  IRenderPassInitialValues,
  vtkRenderPass,
} from '../../SceneGraph/RenderPass';
import vtkWebGPURenderer from '../Renderer';
import vtkWebGPURenderWindow from '../RenderWindow';
import vtkWebGPUTextureView from '../TextureView';

export type IWebGPUDeepFramebufferPassInitialValues =
  IRenderPassInitialValues & {
    /** Average pool budget per pixel and sample, capped by GPU buffer limits. Default: 8. */
    averageFragmentsPerPixel?: number;
    colorTextureView?: Nullable<vtkWebGPUTextureView>;
    depthTextureView?: Nullable<vtkWebGPUTextureView>;
    multisampleColorTextureView?: Nullable<vtkWebGPUTextureView>;
  };

export type vtkWebGPUDeepFramebufferPass = Omit<vtkRenderPass, 'traverse'> & {
  traverse(renderer: vtkWebGPURenderer, view: vtkWebGPURenderWindow): void;
  getColorTextureView(): Nullable<vtkWebGPUTextureView>;
  setColorTextureView(view: Nullable<vtkWebGPUTextureView>): boolean;
  getDepthTextureView(): Nullable<vtkWebGPUTextureView>;
  setDepthTextureView(view: Nullable<vtkWebGPUTextureView>): boolean;
  getMultisampleColorTextureView(): Nullable<vtkWebGPUTextureView>;
  setMultisampleColorTextureView(view: Nullable<vtkWebGPUTextureView>): boolean;
  getAverageFragmentsPerPixel(): number;
  setAverageFragmentsPerPixel(value: number): boolean;
  releaseGraphicsResources(): void;
};

export function extend(
  publicAPI: object,
  model: object,
  initialValues?: IWebGPUDeepFramebufferPassInitialValues
): void;
export function newInstance(
  initialValues?: IWebGPUDeepFramebufferPassInitialValues
): vtkWebGPUDeepFramebufferPass;

declare const vtkWebGPUDeepFramebufferPass: {
  newInstance: typeof newInstance;
  extend: typeof extend;
};
export default vtkWebGPUDeepFramebufferPass;
