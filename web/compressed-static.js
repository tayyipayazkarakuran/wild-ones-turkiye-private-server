"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Ruffle's wasm core is ~14 MB raw but ~4 MB with brotli. Express has no
// built-in compression and the runtime files never change between deploys,
// so each eligible file is compressed once on the libuv thread pool and then
// served from memory. Until a file is ready the raw file is served instead,
// so no request ever waits on the compressor.
const COMPRESSIBLE = /\.(?:wasm|js|map|json|dat|css|html|xml|txt|svg)$/i;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const TYPES = {
  ".wasm": "application/wasm",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".dat": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

function chooseEncoding(header) {
  const accepted = String(header || "").toLowerCase();
  if (/\bbr\b/.test(accepted)) return "br";
  if (/\bgzip\b/.test(accepted)) return "gzip";
  return null;
}

function compressFile(file, encoding) {
  return fs.promises.readFile(file).then((source) => new Promise((resolve, reject) => {
    const done = (error, body) => error ? reject(error) : resolve(body);
    if (encoding === "br") {
      zlib.brotliCompress(source, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length
        }
      }, done);
    } else {
      zlib.gzip(source, { level: 9 }, done);
    }
  }));
}

function compressedStatic(directory, { cacheControl = "public, max-age=0" } = {}) {
  const root = path.resolve(directory);
  const cache = new Map();
  const prepare = (file, stat, encoding) => {
    const key = `${file}\0${encoding}`;
    const entry = cache.get(key);
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return entry;
    const pending = {
      body: null,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      etag: `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}-${encoding}"`
    };
    cache.set(key, pending);
    compressFile(file, encoding)
      .then((body) => { pending.body = body; })
      .catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };
  const middleware = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let relative;
    try { relative = decodeURIComponent(req.path); } catch { return next(); }
    if (!COMPRESSIBLE.test(relative)) return next();
    const encoding = chooseEncoding(req.headers["accept-encoding"]);
    if (!encoding) return next();
    const file = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
    if (!file.startsWith(`${root}${path.sep}`)) return next();
    let stat;
    try { stat = fs.statSync(file); } catch { return next(); }
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES || stat.size < 1024) return next();
    const entry = prepare(file, stat, encoding);
    if (!entry.body) return next();
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("ETag", entry.etag);
    res.setHeader("Cache-Control", cacheControl);
    if (req.headers["if-none-match"] === entry.etag) return res.status(304).end();
    res.setHeader("Content-Encoding", encoding);
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Content-Length", entry.body.length);
    if (req.method === "HEAD") return res.end();
    res.end(entry.body);
  };
  // Compress the large, always-requested files before the first visitor.
  middleware.warm = (relativeFiles) => {
    for (const relative of relativeFiles) {
      const file = path.resolve(root, relative);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      prepare(file, stat, "br");
      prepare(file, stat, "gzip");
    }
  };
  return middleware;
}

module.exports = { compressedStatic, chooseEncoding };
