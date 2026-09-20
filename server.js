const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET; // if unset, files are stored in ./data
const TTL_MS = 3 * 24 * 60 * 60 * 1000; // files live for 3 days
const MAX_FILE = 25 * 1024 * 1024; // bytes; Cloud Run rejects requests over 32 MB
const NAME_RE = /^[a-z0-9_-]{1,64}$/;

// ---- storage: one file per name, either in GCS or in ./data ----
// Both backends expose: stat(name) -> meta|null, write(name, buf, meta), read(name) -> stream, remove(name)
// meta = { filename, size, contentType, savedAt }

function gcsStorage(bucketName) {
  const { Storage } = require('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  return {
    async stat(name) {
      try {
        const [m] = await bucket.file(name).getMetadata();
        const c = m.metadata || {};
        return {
          filename: c.filename || name,
          size: Number(m.size),
          contentType: m.contentType,
          savedAt: Number(c.savedAt),
        };
      } catch (err) {
        if (err.code === 404) return null;
        throw err;
      }
    },
    async write(name, buf, meta) {
      await bucket.file(name).save(buf, {
        contentType: meta.contentType,
        metadata: { metadata: { filename: meta.filename, savedAt: String(meta.savedAt) } },
      });
    },
    read: (name) => bucket.file(name).createReadStream(),
    async remove(name) {
      await bucket.file(name).delete({ ignoreNotFound: true });
    },
  };
}

function localStorage(dir) {
  const blob = (name) => path.join(dir, `${name}.bin`);
  const info = (name) => path.join(dir, `${name}.json`);
  return {
    async stat(name) {
      try {
        return JSON.parse(await fsp.readFile(info(name), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(name, buf, meta) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(blob(name), buf);
      await fsp.writeFile(info(name), JSON.stringify(meta)); // written last: its presence means the file is complete
    },
    read: (name) => fs.createReadStream(blob(name)),
    async remove(name) {
      await fsp.rm(blob(name), { force: true });
      await fsp.rm(info(name), { force: true });
    },
  };
}

const store = BUCKET ? gcsStorage(BUCKET) : localStorage(path.join(__dirname, 'data'));

// returns the live meta for a name, or null. The bucket lifecycle rule deletes lazily
// (up to a day late), so expiry is enforced here too.
async function findLive(name) {
  const meta = await store.stat(name);
  if (!meta) return null;
  if (Date.now() - meta.savedAt > TTL_MS) {
    await store.remove(name);
    return null;
  }
  return meta;
}

// ---- api ----

const app = express();
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: MAX_FILE, files: 1 } });
app.use(express.static(path.join(__dirname, 'public')));

app.param('name', (req, res, next, raw) => {
  const name = String(raw).trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Text must be 1-64 characters: letters, digits, - or _' });
  }
  req.fileName = name;
  next();
});

const publicMeta = (m) => ({ filename: m.filename, size: m.size, savedAt: m.savedAt, expiresAt: m.savedAt + TTL_MS });

// info about the file stored under this text
app.get('/api/files/:name', async (req, res, next) => {
  try {
    const meta = await findLive(req.fileName);
    if (!meta) return res.status(404).json({ error: 'Nothing found for that text (it may have expired).' });
    res.set('Cache-Control', 'no-store');
    res.json(publicMeta(meta));
  } catch (err) {
    next(err);
  }
});

// the file itself
app.get('/api/files/:name/download', async (req, res, next) => {
  try {
    const meta = await findLive(req.fileName);
    if (!meta) return res.status(404).json({ error: 'Nothing found for that text (it may have expired).' });
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': meta.contentType, 'Content-Length': meta.size });
    res.attachment(meta.filename);
    const stream = store.read(req.fileName);
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

app.put('/api/files/:name', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    if (await findLive(req.fileName)) {
      return res.status(409).json({ error: 'That text is already in use. Pick a different one.' });
    }
    const meta = {
      filename: req.file.originalname,
      size: req.file.size,
      contentType: req.file.mimetype || 'application/octet-stream',
      savedAt: Date.now(),
    };
    await store.write(req.fileName, req.file.buffer, meta);
    res.json(publicMeta(meta));
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? `Max file size is ${MAX_FILE / 1024 / 1024} MB` : err.message,
    });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Fileshare listening on :${PORT} (storage: ${BUCKET ? `gcs://${BUCKET}` : './data'})`);
});
