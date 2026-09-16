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
const PUBLIC_URL = process.env.R2_PUBLIC_URL; // e.g. https://pub-xxx.r2.dev or custom domain

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

  const url = `${PUBLIC_URL}/${key}`;

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

module.exports = { r2, upload, uploadToR2, deleteFromR2 };
