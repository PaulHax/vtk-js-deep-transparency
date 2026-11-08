const parameters = new URLSearchParams(location.search);

if (parameters.has('scene')) {
  import('./viewer.js');
} else {
  import('./gallery.js').then(({ createGallery }) => createGallery());
}
