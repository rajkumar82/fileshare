// fresh-server.js: serve public/ so phones always get the newest files (the server half of shared/pwa/fresh.js).
// Copy into the app root, then replace the app's own express.static(public) with:
//   const { serveFresh } = require('./fresh-server');
//   serveFresh(app, express, path.join(__dirname, 'public'), { setHeaders(res, file) { /* the app's own extra headers */ }, transform(html) { return html; } });
// Mount it after the /api routes of accounts and tracker, like the static files were.
//
// - Every file gets an ETag from its contents. Cloud Run sets every file's time to 1980, so express's own ETag (size + time)
//   stayed the same when a file changed but kept its size, and a phone kept its old copy.
// - BUILD (a hash of everything in public/) is stamped into index.html (<meta name="build" content="">) and served at
//   /api/version; public/fresh.js compares the two and reloads when a new version is out.
// - Pages, code, styles and data are sent with Cache-Control: no-cache (always re-checked, 304 when unchanged).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function serveFresh(app, express, pub, opts = {}) {
  const tags = new Map();
  const all = crypto.createHash('sha1');
  (function walk(dir) {
    for (const f of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      const h = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
      tags.set(full, `"${h}"`);
      all.update(path.relative(pub, full) + h);
    }
  })(pub);
  const build = all.digest('hex').slice(0, 12);
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace('<meta name="build" content="">', `<meta name="build" content="${build}">`);
  const page = opts.transform ? opts.transform(html) : html;      // the app's own change to its page (todolist adds its manifest link)

  app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json({ build }));
  app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-cache').set('ETag', `"p-${build}"`).type('html').send(page));
  app.use(express.static(pub, {
    etag: false,
    lastModified: false,
    setHeaders(res, file, stat) {
      if (tags.has(file)) res.set('ETag', tags.get(file));
      if (/\.(html|js|css|json|webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
      if (opts.setHeaders) opts.setHeaders(res, file, stat);
    },
  }));
  return build;
}

module.exports = { serveFresh };
