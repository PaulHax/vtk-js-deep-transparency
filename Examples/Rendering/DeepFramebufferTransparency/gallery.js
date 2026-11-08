import './gallery.css';

const examples = [
  {
    key: 'nested',
    name: 'Nested structures',
    description:
      'An amber trefoil inside a transparent teal shell. Follow the near surface as it passes in front of the knot.',
  },
  {
    key: 'intersecting',
    name: 'Intersecting fields',
    description:
      'Three translucent rings cross through one another. Their depth order changes across the image.',
  },
  {
    key: 'layers',
    name: 'Two-layer proof',
    description:
      'Two unlit rectangles isolate alpha composition. Swap their depths and compare the overlap color.',
  },
  {
    key: 'bonsai',
    name: 'Bonsai',
    description:
      'A real CT scan reveals the trunk, branches and soil beneath the foliage contour.',
  },
  {
    key: 'engine',
    name: 'Engine',
    description:
      'Look through the violet casing to follow the channels and dense internal structure of an engine block.',
  },
  {
    key: 'teapot',
    name: 'Boston Teapot',
    description:
      'The transparent enclosure surrounds a small lobster model captured inside the original CT scan.',
  },
  {
    key: 'impact',
    name: 'Asteroid ocean impact',
    description:
      'Water, temperature and asteroid surfaces intertwine in the LANL simulation at 11.00054 seconds.',
  },
  {
    key: 'anatomy',
    name: 'Sinus anatomy',
    description:
      'Explore both maxillary sinuses, the winding nasal passages and nasopharynx inside translucent facial bone.',
  },
  {
    key: 'cad',
    name: 'Ball-bearing assembly',
    description:
      'Twelve rolling balls fit between grooved races inside a pocketed retainer. Hide individual parts to inspect the fit.',
  },
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
      <div class="gallery-brand"><strong>VTK.js</strong> Rendering laboratory / 01</div>
      <div class="gallery-intro">
        <div><p class="gallery-eyebrow">Order-independent transparency</p><h1>Transparency, in depth.</h1></div>
        <p>Look inside overlapping surfaces. Scroll through nine interactive examples, with weighted blending on the left and sorted alpha composition on the right.</p>
      </div>
      <p class="gallery-controls">Arcball · Left drag rotates with free roll · Right drag pans · Wheel zooms at the pointer</p>
    </header>
    <nav class="gallery-navigation" aria-label="Examples">
      <div>${examples.map(({ key, name }) => `<a href="#${key}">${name}</a>`).join('')}</div>
    </nav>
    <main class="gallery-examples" id="examples">
      ${examples
        .map(
          ({ key, name, description }, index) => `
        <section class="gallery-example" id="${key}" aria-labelledby="${key}-title" data-active="true">
          <div class="gallery-section-heading">
            <div><p class="gallery-number">${String(index + 1).padStart(2, '0')} / 09</p><h2 id="${key}-title" tabindex="-1"><a href="#${key}">${name}</a></h2><p>${description}</p></div>
            <a class="gallery-open" href="?scene=${key}" target="_blank" rel="noreferrer">Open separately ↗</a>
          </div>
          <div class="gallery-stage" data-state="loading">
            <iframe src="${frameUrl(key)}" title="${name}: interactive transparency comparison" loading="eager"></iframe>
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
    };
  });
  const links = [...document.querySelectorAll('.gallery-navigation a')];

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
  };

  const onMessage = (event) => {
    if (
      event.origin !== location.origin ||
      event.data?.type !== 'deep-transparency-size' ||
      !Number.isFinite(event.data.height)
    )
      return;
    const item = items.find(
      ({ iframe }) => iframe.contentWindow === event.source
    );
    if (!item) return;
    const height = Math.max(480, Math.min(4000, Math.ceil(event.data.height)));
    item.stage.style.setProperty('--frame-height', `${height + 2}px`);
  };

  const listeners = items.map((item) => {
    const onLoad = () => {
      const url = new URL(item.iframe.contentWindow.location.href);
      if (
        url.searchParams.get('scene') === item.key &&
        url.searchParams.get('embed') === '1'
      )
        item.stage.dataset.state = 'ready';
    };
    item.iframe.addEventListener('load', onLoad);
    return () => item.iframe.removeEventListener('load', onLoad);
  });

  window.addEventListener('hashchange', showHash);
  window.addEventListener('message', onMessage);
  const initialNavigation = requestAnimationFrame(showHash);
  const gallery = {
    getActiveScenes: () => items.map(({ key }) => key),
    delete: () => {
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
  return gallery;
}
