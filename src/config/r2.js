const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const multer = require("multer");
const crypto = require("crypto");
const AppError = require("../utils/AppError");

// ─── R2 Client ───────────────────────────────────────────────────────────────

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
// e.g. https://pub-xxx.r2.dev or custom domain. The env var is sometimes set
// with a trailing slash — joining it with `${PUBLIC_URL}/${key}` then produced
// `https://pub-xxx.r2.dev//rbstars/...`, and R2 serves a 44/404 for that
// double slash. That's why every image uploaded from the admin panel showed a
// broken-image "cross" (the URL existed but 404'd) and products saved with no
// image. Normalize once here so every built URL is single-slashed.
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

// Collapse any accidental duplicate slashes after the host. The char before
// the `//` can never be `:` so the protocol's own slashes are untouched.
// Exported so the boot-time heal in server.js and the controllers can reuse
// the exact same rule.
function fixR2Url(url) {
  return typeof url === "string" ? url.replace(/([^:])\/\//g, "$1/") : url;
}

// Public URL for an object key. Fails loudly instead of silently producing a
// broken `undefined/...` link when the env var is missing.
function buildPublicUrl(key) {
  if (!PUBLIC_URL) {
    throw new Error("R2_PUBLIC_URL is not configured — set it in the backend env");
  }
  return `${PUBLIC_URL}/${key}`;
}

// ─── Multer middleware (memory-only, images only, 10MB limit) ─────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new AppError("Only image files are allowed", 400));
    }
    cb(null, true);
  },
});

// ─── Upload helper ───────────────────────────────────────────────────────────

function generateKey(folder, originalName) {
  const ext = originalName ? originalName.split(".").pop() : "png";
  const uniqueId = crypto.randomBytes(12).toString("hex");
  const timestamp = Date.now();
  return `${folder}/${timestamp}-${uniqueId}.${ext}`;
}

async function uploadToR2(buffer, options = {}) {
  const folder = options.folder || "rbstars";
  const originalName = options.originalName || "image.png";
  const key = options.publicId || generateKey(folder, originalName);

  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: options.contentType || "image/png",
      ACL: "public-read",
    })
  );

  const url = buildPublicUrl(key);

  return {
    secure_url: url,
    url,
    public_id: key,
    format: key.split(".").pop(),
    bytes: buffer.length,
    folder,
  };
}

// ─── Delete helper ───────────────────────────────────────────────────────────

async function deleteFromR2(publicId) {
  if (!publicId) return;
  try {
    await r2.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: publicId,
      })
    );
  } catch {
    // swallow — same behavior as before
  }
}

module.exports = { r2, upload, uploadToR2, deleteFromR2, buildPublicUrl, fixR2Url };
