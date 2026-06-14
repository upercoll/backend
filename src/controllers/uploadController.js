const { uploadToCloudinary, deleteFromCloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.uploadSingle = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError("No file provided", 400));

  const { folder = "rbstars/uploads", width, height, crop } = req.query;

  const transformation = [];
  if (width || height) {
    transformation.push({
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
      crop: crop || "fill",
      quality: "auto",
    });
  }

  const result = await uploadToCloudinary(req.file.buffer, {
    folder,
    transformation: transformation.length ? transformation : undefined,
  });

  res.json({
    success: true,
    data: { url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height },
  });
});

exports.uploadMultiple = catchAsync(async (req, res, next) => {
  if (!req.files?.length) return next(new AppError("No files provided", 400));

  const { folder = "rbstars/uploads" } = req.query;

  const results = await Promise.all(
    req.files.map((f) =>
      uploadToCloudinary(f.buffer, { folder, transformation: [{ quality: "auto" }] })
    )
  );

  res.json({
    success: true,
    data: {
      files: results.map((r) => ({ url: r.secure_url, publicId: r.public_id })),
    },
  });
});

exports.deleteImage = catchAsync(async (req, res, next) => {
  const { publicId } = req.body;
  if (!publicId) return next(new AppError("publicId required", 400));
  await deleteFromCloudinary(publicId);
  res.json({ success: true, message: "Image deleted" });
});
