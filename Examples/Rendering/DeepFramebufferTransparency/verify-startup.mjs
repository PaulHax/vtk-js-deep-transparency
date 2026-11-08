import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:9999');
if (!base.pathname.endsWith('/')) base.pathname += '/';
base.search = '';
base.hash = '';
const output = path.resolve(
  process.env.DEMO_OUTPUT_DIR || path.join(root, 'comparison/loading')
);
const scenes = [
  'bonsai',
  'engine',
  'teapot',
  'anatomy',
  'impact',
  'cad',
  'intersecting',
  'layers',
];
const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--disable-features=OverlayScrollbar',
  ],
});
await mkdir(output, { recursive: true });

const instrument = async (context) => {
  await context.addInitScript(() => {
    if (window === window.parent) {
      window.startupMeasurements = {
        samples: [],
        states: [],
        maximumLoading: 0,
        attempts: {},
        readyStates: {},
      };
      let lastState = '';
      const states = () => {
        const stages = [...document.querySelectorAll('.gallery-example')].map(
          (section) => ({
            scene: section.id,
            state: section.querySelector('.gallery-stage')?.dataset.state,
            started: Boolean(
              section.querySelector('iframe')?.getAttribute('src')
            ),
          })
        );
        const serialized = JSON.stringify(stages);
        if (serialized !== lastState && stages.length) {
          const loading = stages.filter(
            (stage) => stage.state === 'loading'
          ).length;
          window.startupMeasurements.maximumLoading = Math.max(
            window.startupMeasurements.maximumLoading,
            loading
          );
          window.startupMeasurements.states.push(stages);
          lastState = serialized;
        }
      };
      new MutationObserver(states).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-state', 'src'],
      });
      return;
    }
    const scene = new URL(location.href).searchParams.get('scene');
    if (!scene) return;
    const record = window.parent.startupMeasurements;
    if (!record) return;
    const attempt = (record.attempts[scene] || 0) + 1;
    record.attempts[scene] = attempt;
    let previous = '';
    let trackedReady = false;
    let trackedDevice = false;
    const readiness = { state: 'module pending', scene, attempt };
    record.readyStates[`${scene}:${attempt}`] = readiness;
    const sample = (reason) => {
      if (!trackedReady && globalThis.demo?.ready) {
        trackedReady = true;
        readiness.state = 'pending';
        globalThis.demo.ready.then(
          () => {
            readiness.state = 'resolved';
          },
          (error) => {
            readiness.state = 'rejected';
            readiness.error = String(error?.message || error);
          }
        );
      }
      const device = globalThis.demo?.view?.getDevice()?.getHandle();
      if (!trackedDevice && device) {
        trackedDevice = true;
        device.lost.then((info) => {
          readiness.deviceLost = { reason: info.reason, message: info.message };
        });
      }
      const documentRoot = document.documentElement;
      if (!document.body || !documentRoot || !window.frameElement) return;
      const iframe = window.frameElement;
      const style = getComputedStyle(iframe);
      const value = {
        scene,
        attempt,
        reason,
        width: documentRoot.clientWidth,
        height: documentRoot.clientHeight,
        scrollWidth: documentRoot.scrollWidth,
        scrollHeight: documentRoot.scrollHeight,
        bodyHeight: document.body.getBoundingClientRect().height,
        visible:
          !iframe.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0,
        documentOverflowY: getComputedStyle(documentRoot).overflowY,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        scrolling: iframe.getAttribute('scrolling'),
      };
      const serialized = JSON.stringify({ ...value, reason: '' });
      if (serialized !== previous) {
        record.samples.push(value);
        previous = serialized;
      }
    };
    const tick = () => {
      sample('animation frame');
      if (!window.parent.stopStartupMeasurements) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    addEventListener('DOMContentLoaded', () => {
      sample('document ready');
      new ResizeObserver(() => sample('body resize')).observe(document.body);
    });
  });
};

const waitForStage = (page, scene, expected) =>
  page.evaluate(
    ({ scene: name, expected: target }) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const section = document.getElementById(name);
          const state = section?.querySelector('.gallery-stage')?.dataset.state;
          if (state === target) {
            observer.disconnect();
            resolve();
          } else if (state === 'error') {
            observer.disconnect();
            const message = section.querySelector(
              '.gallery-loading-message'
            )?.textContent;
            reject(
              new Error(`${name}: ${message || 'The demo could not load'}`)
            );
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-state'],
        });
        check();
      }),
    { scene, expected }
  );

const ready = async (page, name) => {
  await waitForStage(page, name, 'ready');
  const frame = await (
    await page.locator(`section#${name} iframe`).elementHandle()
  ).contentFrame();
  await frame.evaluate(() => globalThis.demo.ready);
  await frame.evaluate(() => globalThis.demo.controls.whenIdle());
  return frame;
};

const allReady = (page) => Promise.all(scenes.map((name) => ready(page, name)));
const settlePaint = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  );

const inspectMeasurements = async (page, label) => {
  await settlePaint(page);
  const record = await page.evaluate(() => window.startupMeasurements);
  assert.ok(
    record.samples.length > 0,
    `${label}: startup measurements were captured`
  );
  assert.ok(
    record.maximumLoading > 0,
    `${label}: loading states were observed`
  );
  assert.ok(
    record.maximumLoading <= 2,
    `${label}: no more than two demos initialize together`
  );
  const meaningful = record.samples.filter(
    (sample) => sample.width > 0 && sample.height > 0
  );
  const overflow = meaningful.filter(
    (sample) =>
      sample.scrollHeight > sample.height || sample.scrollWidth > sample.width
  );
  const visibleOverflow = overflow.filter((sample) => sample.visible);
  assert.deepEqual(
    visibleOverflow,
    [],
    `${label}: visible embedded documents must fit at every observed paint`
  );
  assert.deepEqual(
    overflow,
    [],
    `${label}: startup sizing must remove overflow rather than hide it`
  );
  for (const sample of meaningful) {
    assert.ok(
      !['hidden', 'clip'].includes(sample.documentOverflowY),
      `${label}: HTML does not suppress scrolling`
    );
    assert.ok(
      !['hidden', 'clip'].includes(sample.bodyOverflowY),
      `${label}: body does not suppress scrolling`
    );
    assert.notEqual(
      sample.scrolling,
      'no',
      `${label}: iframe scrolling is not disabled`
    );
  }
  const elapsedMilliseconds = Date.now() - phaseStarted;
  console.log(
    `Completed ${label}: all eight demos ready, ${overflow.length} overflow samples, at most ${record.maximumLoading} initializations (${elapsedMilliseconds} ms observed).`
  );
  return {
    label,
    elapsedMilliseconds,
    maximumLoading: record.maximumLoading,
    samples: record.samples,
    transitions: record.states,
    attempts: record.attempts,
    readyStates: record.readyStates,
    overflowSamples: overflow.length,
    visibleOverflowSamples: visibleOverflow.length,
  };
};

const reports = [];
const requests = new Map();
const networkEvents = [];
const browserEvents = [];
let activePage = null;
let phase = 'desktop initialization';
let phaseStarted = Date.now();
const trackPage = (page) => {
  activePage = page;
  page.on('request', (request) => {
    requests.set(request, {
      url: request.url(),
      type: request.resourceType(),
      started: Date.now(),
    });
  });
  page.on('requestfinished', (request) => {
    requests.delete(request);
  });
  page.on('requestfailed', (request) => {
    requests.delete(request);
    networkEvents.push({
      url: request.url(),
      error: request.failure()?.errorText,
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      networkEvents.push({ url: response.url(), status: response.status() });
  });
  page.on('pageerror', (error) =>
    browserEvents.push({ type: 'pageerror', message: error.message })
  );
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()))
      browserEvents.push({
        type: message.type(),
        message: message.text(),
        location: message.location(),
      });
  });
};
const captureFailure = async (error) => {
  const diagnostics = {
    base: base.href,
    phase,
    error: { message: error.message, stack: error.stack },
    reports,
    networkEvents,
    browserEvents,
    outstandingRequests: [...requests.values()].map((request) => ({
      ...request,
      elapsedMilliseconds: Date.now() - request.started,
    })),
  };
  try {
    diagnostics.page = await activePage.evaluate(() => ({
      url: location.href,
      measurements: window.startupMeasurements,
      stages: [...document.querySelectorAll('.gallery-example')].map(
        (section) => {
          const iframe = section.querySelector('iframe');
          const child = iframe?.contentDocument;
          const root = child?.documentElement;
          return {
            scene: section.id,
            state: section.querySelector('.gallery-stage')?.dataset.state,
            message: section.querySelector('.gallery-loading-message')
              ?.textContent,
            src: iframe?.getAttribute('src'),
            childURL: iframe?.contentWindow?.location.href,
            documentReadyState: child?.readyState,
            childStatus: child?.querySelector('#status')?.textContent,
            childError: child?.querySelector('#error')?.textContent,
            metrics: root
              ? {
                  clientWidth: root.clientWidth,
                  clientHeight: root.clientHeight,
                  scrollWidth: root.scrollWidth,
                  scrollHeight: root.scrollHeight,
                }
              : null,
          };
        }
      ),
    }));
    await activePage.screenshot({ path: path.join(output, 'failure.png') });
  } catch (diagnosticError) {
    diagnostics.captureError = String(diagnosticError);
  }
  await writeFile(
    path.join(output, 'failure.json'),
    `${JSON.stringify(diagnostics, null, 2)}\n`
  );
  await writeFile(
    path.join(output, 'report.partial.json'),
    `${JSON.stringify({ base: base.href, phase, reports }, null, 2)}\n`
  );
  console.error(
    JSON.stringify(
      {
        phase,
        stages: diagnostics.page?.stages,
        outstandingRequests: diagnostics.outstandingRequests,
        browserEvents,
      },
      null,
      2
    )
  );
};
try {
  const context = await browser.newContext({
    viewport: { width: 1014, height: 1161 },
    deviceScaleFactor: 1,
  });
  await instrument(context);
  const page = await context.newPage();
  trackPage(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let firstTeapotFailure = true;
  let releaseBonsai;
  const bonsaiGate = new Promise((resolve) => {
    releaseBonsai = resolve;
  });
  let bonsaiStarted;
  const bonsaiRequested = new Promise((resolve) => {
    bonsaiStarted = resolve;
  });
  await context.route(
    '**/Data/deep-transparency/scans/bonsai-35.vtp',
    async (route) => {
      bonsaiStarted();
      await bonsaiGate;
      await route.continue();
    }
  );
  await context.route(
    '**/Data/deep-transparency/scans/teapot-50.vtp',
    async (route) => {
      if (firstTeapotFailure) {
        firstTeapotFailure = false;
        await route.fulfill({
          status: 503,
          contentType: 'text/plain',
          body: 'Deliberate loading failure for retry verification',
        });
      } else await route.continue();
    }
  );
  phase = 'desktop progressive load and retry';
  phaseStarted = Date.now();
  console.log(`Checking ${phase}`);
  await page.goto(base.href);
  await bonsaiRequested;
  await ready(page, 'engine');
  assert.equal(
    await page
      .locator('section#bonsai .gallery-stage')
      .getAttribute('data-state'),
    'loading'
  );
  assert.equal(
    await page.locator('section#bonsai [role="status"]').isVisible(),
    true,
    'A blocked demo keeps its loading status visible'
  );
  await page
    .locator('section#bonsai')
    .screenshot({ path: path.join(output, 'progressive-loading.png') });
  await waitForStage(page, 'teapot', 'error');
  await ready(page, 'cad');
  assert.equal(
    await page
      .locator('section#teapot .gallery-stage')
      .getAttribute('data-state'),
    'error',
    'A failed demo does not stall the remaining queue'
  );
  await page
    .locator('section#teapot')
    .screenshot({ path: path.join(output, 'load-error.png') });
  releaseBonsai();
  await ready(page, 'bonsai');
  await page
    .locator('section#teapot')
    .getByRole('button', { name: /retry/i })
    .click();
  await allReady(page);
  await page
    .locator('section#teapot')
    .screenshot({ path: path.join(output, 'retried-demo.png') });
  reports.push(
    await inspectMeasurements(page, 'desktop progressive load and retry')
  );
  assert.deepEqual(
    errors,
    [],
    'A handled dataset failure must not produce an uncaught page error'
  );
  phase = 'desktop refresh';
  phaseStarted = Date.now();
  console.log(`Checking ${phase}`);
  await page.reload();
  await allReady(page);
  reports.push(await inspectMeasurements(page, 'desktop refresh'));
  await page.evaluate(() => {
    window.stopStartupMeasurements = true;
  });
  await context.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  await instrument(mobile);
  const mobilePage = await mobile.newPage();
  trackPage(mobilePage);
  phase = 'mobile startup';
  phaseStarted = Date.now();
  console.log(`Checking ${phase}`);
  await mobilePage.goto(base.href);
  await allReady(mobilePage);
  reports.push(await inspectMeasurements(mobilePage, 'mobile startup'));
  await mobilePage
    .locator('section#anatomy')
    .screenshot({ path: path.join(output, 'mobile-anatomy.png') });
  phase = 'mobile refresh';
  phaseStarted = Date.now();
  console.log(`Checking ${phase}`);
  await mobilePage.reload();
  await allReady(mobilePage);
  reports.push(await inspectMeasurements(mobilePage, 'mobile refresh'));
  await mobilePage.evaluate(() => {
    window.stopStartupMeasurements = true;
  });
  await mobile.close();
  await writeFile(
    path.join(output, 'report.json'),
    `${JSON.stringify({ base: base.href, reports }, null, 2)}\n`
  );
  console.log(
    `Startup sizing, progressive loading and retry checks passed: ${output}`
  );
} catch (error) {
  await captureFailure(error);
  throw error;
} finally {
  await browser.close();
}
