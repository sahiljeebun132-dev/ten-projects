'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp']
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust the client filename: derive a random name from the mime type.
    const ext = ALLOWED.get(file.mimetype) || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  if (!ALLOWED.has(file.mimetype)) {
    return cb(Object.assign(new Error('Only JPEG, PNG, GIF or WebP images are allowed'), { status: 400, isUpload: true }));
  }
  if (!/\.(jpe?g|png|gif|webp)$/i.test(file.originalname || '')) {
    return cb(Object.assign(new Error('Unsupported image file extension'), { status: 400, isUpload: true }));
  }
  return cb(null, true);
}

const uploadCover = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_BYTES, files: 1, fields: 30 }
}).single('cover');

/** Wrap multer so its errors become friendly, non-fatal validation errors. */
function coverUpload(req, res, next) {
  uploadCover(req, res, (err) => {
    req.multipartParsed = true;
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      err.message = 'Cover image must be 2 MB or smaller';
    }
    err.status = err.status || 400;
    err.isUpload = true;
    return next(err);
  });
}

/** Remove a previously uploaded cover image from disk (best effort). */
function removeUpload(relativePath) {
  if (!relativePath || !relativePath.startsWith('/uploads/')) return;
  const abs = path.join(UPLOAD_DIR, path.basename(relativePath));
  fs.promises.unlink(abs).catch(() => {});
}

module.exports = { coverUpload, removeUpload, UPLOAD_DIR, MAX_BYTES, ALLOWED };
