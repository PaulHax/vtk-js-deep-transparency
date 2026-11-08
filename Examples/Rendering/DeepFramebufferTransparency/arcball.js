import { quat, vec3 } from 'gl-matrix';

const vector = () => new Float64Array(3);
const subtract = (a, b) => vec3.subtract(vector(), a, b);
const add = (a, b) => vec3.add(vector(), a, b);
const scale = (a, amount) => vec3.scale(vector(), a, amount);
const normalize = (a) => vec3.normalize(vector(), a);
const cross = (a, b) => vec3.cross(vector(), a, b);

const spherePoint = (point, viewport, basis) => {
  const radius = Math.min(viewport.width, viewport.height) / 2;
  const x = (point.x - viewport.left - viewport.width / 2) / radius;
  const y = (viewport.top + viewport.height / 2 - point.y) / radius;
  const length = x * x + y * y;
  // The hyperbolic continuation matches the sphere's slope at r² = 1/2,
  // keeping rotation speed finite when a captured pointer crosses the rim.
  const z = length <= 0.5 ? Math.sqrt(1 - length) : 0.5 / Math.sqrt(length);
  return normalize(
    add(add(scale(basis.right, x), scale(basis.up, y)), scale(basis.back, z))
  );
};

const sceneStamp = (renderer) =>
  renderer
    .getActors()
    .map((actor) => {
      const mapper = actor.getMapper();
      return [
        actor.getMTime(),
        actor.getProperty().getMTime(),
        mapper?.getMTime(),
        mapper?.getInputData()?.getMTime(),
      ].join(':');
    })
    .join('|');

export const createArcballControls = ({ view, renderers, camera, render }) => {
  const canvas = view.getCanvas();
  const selector = view.createSelector();
  selector.setCaptureZValues(true);
  const previousTouchAction = canvas.style.touchAction;
  const previousTabIndex = canvas.getAttribute('tabindex');
  const ownerWindow = canvas.ownerDocument.defaultView;
  canvas.style.touchAction = 'none';
  canvas.tabIndex = 0;
  const hasFocus = () =>
    canvas.ownerDocument.activeElement === canvas &&
    canvas.ownerDocument.hasFocus();
  let gesture = null;
  let generation = 0;
  let anchorCache = null;
  let wheelTask = null;
  let activeWheel = null;
  let renderTask = null;
  let renderDirty = false;
  let disposed = false;
  const wheelQueue = [];

  const scheduleRender = () => {
    renderDirty = true;
    if (!renderTask) {
      renderTask = new Promise((resolve) => {
        requestAnimationFrame(async () => {
          try {
            while (renderDirty && !disposed) {
              renderDirty = false;
              await render();
            }
          } catch (error) {
            console.error(error);
          } finally {
            renderTask = null;
            resolve();
          }
        });
      });
    }
    return renderTask;
  };

  const locate = (event) => {
    const rect = canvas.getBoundingClientRect();
    const [width, height] = view.getSize();
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (rect.bottom - event.clientY) / rect.height;
    const renderer = renderers.find((candidate) => {
      const [left, bottom, right, top] = candidate.getViewport();
      return nx >= left && nx < right && ny >= bottom && ny <= top;
    });
    if (!renderer) return null;
    const [left, bottom, right, top] = renderer.getViewport();
    return {
      renderer,
      x: event.clientX,
      y: event.clientY,
      display: [nx * width, ny * height],
      size: `${width}:${height}`,
      viewport: {
        left: rect.left + left * rect.width,
        top: rect.bottom - top * rect.height,
        width: (right - left) * rect.width,
        height: (top - bottom) * rect.height,
      },
    };
  };

  const stopGesture = () => {
    if (gesture && canvas.hasPointerCapture(gesture.pointerId))
      canvas.releasePointerCapture(gesture.pointerId);
    gesture = null;
  };

  const cancel = () => {
    generation += 1;
    wheelQueue.length = 0;
    anchorCache = null;
    stopGesture();
  };

  const onPointerDown = (event) => {
    if (
      !view.getInitialized() ||
      !event.isPrimary ||
      ![0, 2].includes(event.button)
    )
      return;
    const point = locate(event);
    if (!point) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    cancel();
    const position = [...camera.getPosition()];
    const focal = [...camera.getFocalPoint()];
    const viewUp = [...camera.getViewUp()];
    const back = normalize(subtract(position, focal));
    const right = normalize(cross(viewUp, back));
    const basis = { back, right, up: cross(back, right) };
    const focalDepth = view.worldToDisplay(...focal, point.renderer)[2];
    const panOrigin = view.displayToWorld(
      ...point.display,
      focalDepth,
      point.renderer
    );
    const panX = view.displayToWorld(
      point.display[0] + 1,
      point.display[1],
      focalDepth,
      point.renderer
    );
    const panY = view.displayToWorld(
      point.display[0],
      point.display[1] + 1,
      focalDepth,
      point.renderer
    );
    gesture = {
      ...point,
      pointerId: event.pointerId,
      button: event.button,
      position,
      focal,
      viewUp,
      basis,
      sphere: spherePoint(point, point.viewport, basis),
      stepX: subtract(panX, panOrigin),
      stepY: subtract(panY, panOrigin),
    };
    canvas.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (gesture.size !== view.getSize().join(':')) {
      cancel();
      return;
    }
    event.preventDefault();
    if (gesture.button === 0) {
      const end = spherePoint(
        { x: event.clientX, y: event.clientY },
        gesture.viewport,
        gesture.basis
      );
      // Endpoint quaternions permit free roll without a fixed world-up axis.
      const axis = cross(gesture.sphere, end);
      const rotation = quat.normalize(new Float64Array(4), [
        -axis[0],
        -axis[1],
        -axis[2],
        vec3.dot(gesture.sphere, end),
      ]);
      const offset = vec3.transformQuat(
        vector(),
        subtract(gesture.position, gesture.focal),
        rotation
      );
      camera.setPosition(...add(gesture.focal, offset));
      camera.setViewUp(
        ...vec3.transformQuat(vector(), gesture.viewUp, rotation)
      );
    } else {
      const rect = canvas.getBoundingClientRect();
      const [width, height] = view.getSize();
      const dx = ((event.clientX - gesture.x) / rect.width) * width;
      const dy = ((gesture.y - event.clientY) / rect.height) * height;
      const translation = add(
        scale(gesture.stepX, -dx),
        scale(gesture.stepY, -dy)
      );
      camera.setPosition(...add(gesture.position, translation));
      camera.setFocalPoint(...add(gesture.focal, translation));
    }
    scheduleRender();
  };

  const onPointerUp = (event) => {
    if (event.pointerId === gesture?.pointerId) stopGesture();
  };

  const samePointer = (a, b) =>
    a &&
    b &&
    a.renderer === b.renderer &&
    a.x === b.x &&
    a.y === b.y &&
    a.size === b.size &&
    a.generation === b.generation;

  const findAnchor = async (request) => {
    const stamp = sceneStamp(request.renderer);
    if (
      samePointer(request, anchorCache) &&
      anchorCache.cameraTime === camera.getMTime() &&
      anchorCache.stamp === stamp
    )
      return anchorCache.world;
    const cameraTime = camera.getMTime();
    selector.attach(view, request.renderer);
    const source = await selector.getSourceDataAsync(request.renderer);
    if (
      request.generation !== generation ||
      cameraTime !== camera.getMTime() ||
      stamp !== sceneStamp(request.renderer) ||
      request.size !== view.getSize().join(':')
    )
      return null;
    if (!source)
      throw new Error('Could not capture the surface under the cursor');
    const [x, y] = request.display.map(Math.floor);
    const nodes = source.generateSelection(x, y, x, y);
    const depth = nodes.length
      ? nodes[0].getProperties().displayPosition[2]
      : view.worldToDisplay(...camera.getFocalPoint(), request.renderer)[2];
    // Unproject at the exact pointer coordinate, retaining the nearest surface depth.
    return view.displayToWorld(...request.display, depth, request.renderer);
  };

  const drainWheels = async () => {
    while (wheelQueue.length && !disposed) {
      const request = wheelQueue.shift();
      activeWheel = request;
      const world = await findAnchor(request);
      if (world && request.generation === generation && hasFocus()) {
        const factor = Math.exp(
          Math.max(-2.3, Math.min(2.3, -request.delta * 0.0015))
        );
        request.applied = true;
        camera.setPosition(
          ...add(
            world,
            scale(subtract(camera.getPosition(), world), 1 / factor)
          )
        );
        camera.setFocalPoint(
          ...add(
            world,
            scale(subtract(camera.getFocalPoint(), world), 1 / factor)
          )
        );
        if (camera.getParallelProjection())
          camera.setParallelScale(camera.getParallelScale() / factor);
        await scheduleRender();
        anchorCache = {
          ...request,
          world,
          stamp: sceneStamp(request.renderer),
          cameraTime: camera.getMTime(),
        };
      }
      activeWheel = null;
    }
  };

  const onWheel = (event) => {
    if (!view.getInitialized() || !hasFocus()) return;
    const point = locate(event);
    if (!point) return;
    event.preventDefault();
    stopGesture();
    const deltaScale =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? point.viewport.height
          : 1;
    const request = { ...point, generation, delta: event.deltaY * deltaScale };
    if (samePointer(activeWheel, request) && !activeWheel.applied)
      activeWheel.delta += request.delta;
    else if (samePointer(wheelQueue.at(-1), request))
      wheelQueue.at(-1).delta += request.delta;
    else wheelQueue.push(request);
    if (!wheelTask) {
      wheelTask = drainWheels()
        .catch((error) => console.error(error))
        .finally(() => {
          wheelTask = null;
        });
    }
  };

  const preventContextMenu = (event) => event.preventDefault();
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      canvas.blur();
    }
  };
  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['lostpointercapture', onPointerUp],
    ['contextmenu', preventContextMenu],
    ['wheel', onWheel],
    ['keydown', onKeyDown],
    ['blur', cancel],
  ];
  listeners.forEach(([name, listener]) =>
    canvas.addEventListener(name, listener, { passive: false })
  );
  ownerWindow.addEventListener('blur', cancel);

  return {
    cancel,
    whenIdle: async () => {
      while (wheelTask || renderTask) await (wheelTask || renderTask);
    },
    delete: () => {
      cancel();
      disposed = true;
      listeners.forEach(([name, listener]) =>
        canvas.removeEventListener(name, listener)
      );
      ownerWindow.removeEventListener('blur', cancel);
      selector.delete();
      canvas.style.touchAction = previousTouchAction;
      if (previousTabIndex === null) canvas.removeAttribute('tabindex');
      else canvas.setAttribute('tabindex', previousTabIndex);
    },
  };
};
