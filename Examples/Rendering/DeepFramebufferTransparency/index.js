const parameters = new URLSearchParams(location.search);

if (parameters.has('scene')) {
  import('./viewer.js').catch(() => {
    const message = 'This example could not start. Please retry loading.';
    if (parameters.has('embed') && parent !== window) {
      parent.postMessage(
        { type: 'deep-transparency-status', state: 'error', message },
        location.origin
      );
    }
    const detail = document.createElement('p');
    detail.textContent = message;
    document.body.replaceChildren(detail);
  });
} else {
  import('./gallery.js').then(({ createGallery }) => createGallery());
}
