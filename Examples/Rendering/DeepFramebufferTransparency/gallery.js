import './gallery.css';

const examples = [
  { key: 'bonsai', name: 'Bonsai' },
  { key: 'engine', name: 'Engine' },
  { key: 'anatomy', name: 'Sinus anatomy' },
  { key: 'impact', name: 'Asteroid ocean impact' },
  { key: 'cad', name: 'Ball-bearing assembly' },
  { key: 'teapot', name: 'Boston Teapot' },
  { key: 'intersecting', name: 'Intersecting rings' },
  { key: 'layers', name: 'Two-layer proof' },
];

const frameUrl = (key) => {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('scene', key);
  url.searchParams.set('embed', '1');
  return url.href;
};

export function createGallery() {
  document.title = 'VTK.js | Transparency gallery';
  document.body.className = 'gallery-page';
  document.body.innerHTML = `
    <a class="gallery-skip" href="#examples">Skip to examples</a>
    <header class="gallery-header">
      <div class="gallery-masthead">
        <div class="gallery-brand"><strong>VTK.js</strong> Rendering laboratory</div>
        <a class="gallery-source" href="https://github.com/PaulHax/vtk-js-deep-transparency" target="_blank" rel="noreferrer">Fork me on GitHub ↗</a>
      </div>
      <div class="gallery-intro">
        <div><p class="gallery-eyebrow">Order-independent transparency</p><h1>Transparency, in depth.</h1></div>
        <p>Look inside overlapping surfaces. Scroll through eight interactive examples, with weighted blending on the left and sorted alpha composition on the right. <a class="gallery-read-more" href="https://www.kitware.com/better-transparency-with-vtk-and-webgpu/" target="_blank" rel="noreferrer">Read more ↗</a></p>
      </div>
      <a class="gallery-article" href="https://www.kitware.com/better-transparency-with-vtk-and-webgpu/" target="_blank" rel="noreferrer">Kitware: Better Transparency with VTK and WebGPU ↗</a>
    </header>
    <nav class="gallery-navigation" aria-label="Examples">
      <div>${examples.map(({ key, name }) => `<a href="#${key}">${name}</a>`).join('')}</div>
    </nav>
    <main class="gallery-examples" id="examples">
      ${examples
        .map(
          ({ key, name }) => `
        <section class="gallery-example" id="${key}" aria-labelledby="${key}-title" data-active="false">
          <div class="gallery-section-heading">
            <h2 id="${key}-title" tabindex="-1"><a href="#${key}">${name}</a></h2>
            <a class="gallery-open" href="?scene=${key}" target="_blank" rel="noreferrer">Open separately ↗</a>
          </div>
          <div class="gallery-stage" data-state="queued" aria-busy="true">
            <div class="gallery-loading" role="status" aria-live="polite">
              <span class="gallery-spinner" aria-hidden="true"></span>
              <p class="gallery-loading-message">Waiting to load ${name}</p>
              <button class="gallery-retry" type="button" hidden>Retry loading</button>
            </div>
            <iframe title="${name}: interactive transparency comparison" tabindex="-1"></iframe>
          </div>
        </section>`
        )
        .join('')}
    </main>
    <footer class="gallery-footer"><span>WebGPU · Scientific datasets and procedural geometry</span><a href="https://www.kitware.com/better-transparency-with-vtk-and-webgpu/" target="_blank" rel="noreferrer">VTK deep framebuffer article ↗</a><a href="#">Back to top ↑</a></footer>
  `;

  const items = examples.map((example) => {
    const section = document.getElementById(example.key);
    return {
      ...example,
      section,
      iframe: section.querySelector('iframe'),
      stage: section.querySelector('.gallery-stage'),
      loading: section.querySelector('.gallery-loading'),
      message: section.querySelector('.gallery-loading-message'),
      spinner: section.querySelector('.gallery-spinner'),
      retry: section.querySelector('.gallery-retry'),
      state: 'queued',
    };
  });
  const links = [...document.querySelectorAll('.gallery-navigation a')];
  let initializing = 0;
  let disposed = false;

  const itemForSource = (source) =>
    items.find(({ iframe }) => iframe.contentWindow === source);

  const resizeFrame = (source, contentHeight) => {
    const item = itemForSource(source);
    if (!item || !Number.isFinite(contentHeight) || contentHeight <= 0)
      return false;
    item.iframe.style.height = `${Math.ceil(contentHeight)}px`;
    return true;
  };

  const start = (item) => {
    item.state = 'loading';
    item.stage.dataset.state = 'loading';
    item.section.dataset.active = 'true';
    item.stage.setAttribute('aria-busy', 'true');
    item.loading.hidden = false;
    item.spinner.hidden = false;
    item.retry.hidden = true;
    item.message.textContent = `Loading ${item.name}`;
    initializing += 1;
    item.iframe.src = frameUrl(item.key);
  };

  const pump = () => {
    if (disposed) return;
    while (initializing < 2) {
      const queued = items.filter(({ state }) => state === 'queued');
      const next =
        queued.find(({ key }) => location.hash === `#${key}`) || queued[0];
      if (!next) return;
      start(next);
    }
  };

  const finish = (item, state, message) => {
    if (item.state !== 'loading') return;
    item.state = state;
    item.stage.dataset.state = state;
    item.stage.setAttribute('aria-busy', 'false');
    item.loading.hidden = state === 'ready';
    item.iframe.tabIndex = state === 'ready' ? 0 : -1;
    item.spinner.hidden = state === 'error';
    item.retry.hidden = state !== 'error';
    item.message.textContent =
      message ||
      (state === 'ready'
        ? `${item.name} is ready`
        : `Could not load ${item.name}`);
    initializing -= 1;
    pump();
  };

  const showHash = () => {
    const item = items.find(({ key }) => location.hash === `#${key}`);
    if (item) {
      item.section.scrollIntoView({ block: 'start' });
      item.section.querySelector('h2').focus({ preventScroll: true });
    }
    links.forEach((link) => {
      if (item && link.hash === `#${item.key}`)
        link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    pump();
  };

  const onMessage = (event) => {
    if (
      event.origin !== location.origin ||
      event.data?.type !== 'deep-transparency-status'
    )
      return;
    const item = itemForSource(event.source);
    if (!item || item.state !== 'loading') return;
    const { state, message, height } = event.data;
    if (Number.isFinite(height)) resizeFrame(event.source, height);
    if (state === 'loading') {
      if (typeof message === 'string') item.message.textContent = message;
    } else if (state === 'ready') {
      const document = item.iframe.contentDocument;
      const root = document?.documentElement;
      const fits =
        root &&
        root.scrollHeight <= root.clientHeight &&
        root.scrollWidth <= root.clientWidth;
      finish(
        item,
        fits ? 'ready' : 'error',
        fits ? '' : `Could not display ${item.name}. Retry loading.`
      );
    } else if (state === 'error') {
      finish(item, state, typeof message === 'string' ? message : '');
    }
  };

  const listeners = items.map((item) => {
    const onError = () => finish(item, 'error', `Could not load ${item.name}`);
    const onRetry = () => {
      if (item.state !== 'error') return;
      const previous = item.iframe;
      const replacement = previous.cloneNode(false);
      replacement.removeAttribute('src');
      replacement.tabIndex = -1;
      previous.removeEventListener('error', onError);
      replacement.addEventListener('error', onError);
      item.iframe = replacement;
      previous.replaceWith(replacement);
      item.state = 'queued';
      item.stage.dataset.state = 'queued';
      item.retry.hidden = true;
      item.spinner.hidden = false;
      item.stage.setAttribute('aria-busy', 'true');
      item.message.textContent = `Waiting to load ${item.name}`;
      pump();
    };
    item.retry.addEventListener('click', onRetry);
    item.iframe.addEventListener('error', onError);
    return () => {
      item.retry.removeEventListener('click', onRetry);
      item.iframe.removeEventListener('error', onError);
    };
  });

  window.addEventListener('hashchange', showHash);
  window.addEventListener('message', onMessage);
  const initialNavigation = requestAnimationFrame(showHash);
  const gallery = {
    resizeFrame,
    getActiveScenes: () =>
      items.filter(({ state }) => state === 'ready').map(({ key }) => key),
    delete: () => {
      disposed = true;
      cancelAnimationFrame(initialNavigation);
      window.removeEventListener('hashchange', showHash);
      window.removeEventListener('message', onMessage);
      listeners.forEach((remove) => remove());
      items.forEach(({ iframe }) => {
        iframe.src = 'about:blank';
        iframe.removeAttribute('src');
      });
    },
  };
  globalThis.gallery = gallery;
  pump();
  return gallery;
}
