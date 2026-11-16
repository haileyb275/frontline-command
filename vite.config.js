import { defineConfig } from 'vite';

// Vite is our build tool. In development it serves the files with instant
// reloads; `npm run build` bundles everything into plain static files in
// /dist, which is exactly what GitHub Pages can host.
export default defineConfig({
  // GitHub Pages serves a project site from a sub-folder:
  //   https://<user>.github.io/<repo-name>/
  // A relative base ('./') makes every asset URL relative to index.html, so
  // the build works no matter what the repository is called.
  base: './',
});
