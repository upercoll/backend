const Product = require("../models/Product");
const Category = require("../models/Category");
const Game = require("../models/Game");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const APIFeatures = require("../utils/apiFeatures");

// Multipart/form-data always sends primitives as strings, so array fields
// (images, features) arrive JSON-encoded from the admin panel. This safely
// turns them back into real arrays before they hit the schema.
function parseArrayField(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim()) {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {
      return val.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return undefined;
}

// Multipart always delivers strings; anything outside the allowed set falls
// back to "square" instead of tripping the schema enum into a 500.
const IMAGE_SHAPES = ["square", "vertical", "horizontal"];
function sanitizeImageShape(val) {
  return IMAGE_SHAPES.includes(val) ? val : "square";
}

// Multipart sends objects/arrays as JSON-encoded strings. Parse them back and
// drop anything that doesn't match the expected shape.
function parseJsonField(val) {
  if (val == null || val === "") return undefined;
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return undefined;
  }
}

function sanitizeNotice(val) {
  const notice = parseJsonField(val);
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) return undefined;
  const text = typeof notice.text === "string" ? notice.text.trim().slice(0, 1000) : "";
  return { text, required: notice.required === true || notice.required === "true" };
}

function sanitizeVariations(val) {
  const variations = parseJsonField(val);
  if (!Array.isArray(variations)) return undefined;
  return variations
    .filter((v) => v && typeof v === "object")
    .map((v) => ({
      name: typeof v.name === "string" ? v.name.trim().slice(0, 80) : "",
      options: Array.isArray(v.options)
        ? v.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim().slice(0, 80)).slice(0, 30)
        : [],
    }))
    .filter((v) => v.name && v.options.length > 0)
    .slice(0, 10);
}

exports.getAll = catchAsync(async (req, res) => {
  const features = new APIFeatures(Product.find({ active: true }), req.query)
    .filter()
    .search(["name", "description", "tags"])
    .sort()
    .limitFields()
    .paginate();

  const [products, total] = await Promise.all([
    features.query.populate("category", "name slug icon"),
    Product.countDocuments({ active: true }),
  ]);

  res.json({
    success: true,
    total,
    count: products.length,
    data: products,
  });
});

exports.getByGame = catchAsync(async (req, res) => {
  const { game } = req.params;
  const features = new APIFeatures(Product.find({ game, active: true }), req.query)
    .filter()
    .search(["name", "tags"])
    .sort()
    .limitFields()
    .paginate();

  const [products, total] = await Promise.all([
    features.query.populate("category", "name slug icon"),
    Product.countDocuments({ game, active: true }),
  ]);

  res.json({ success: true, total, count: products.length, data: products });
});

exports.getOne = catchAsync(async (req, res, next) => {
  const product = await Product.findOne({
    $or: [{ _id: req.params.id }, { slug: req.params.id }],
    active: true,
  }).populate("category", "name slug icon");

  if (!product) return next(new AppError("Product not found", 404));

  Product.findByIdAndUpdate(product._id, { $inc: { viewCount: 1 } }).catch(() => {});

  const game = product.game
    ? await Game.findOne({ slug: product.game }, "bgImageUrl").lean()
    : null;

  const data = product.toObject();
  if (game?.bgImageUrl) data.gameBgImageUrl = game.bgImageUrl;

  res.json({ success: true, data });
});

exports.getRelated = catchAsync(async (req, res, next) => {
  const product = await Product.findOne({
    $or: [{ _id: req.params.id }, { slug: req.params.id }],
  });
  if (!product) return next(new AppError("Product not found", 404));

  const limit = Math.min(20, parseInt(req.query.limit) || 12);

  const related = await Product.find({
    category: product.category,
    _id: { $ne: product._id },
    active: true,
  })
    .sort("-bestSeller -featured -salesCount -createdAt")
    .limit(limit)
    .populate("category", "name slug icon");

  res.json({ success: true, count: related.length, data: related });
});

exports.getFeatured = catchAsync(async (req, res) => {
  const products = await Product.find({ featured: true, active: true })
    .sort("-createdAt")
    .limit(12)
    .populate("category", "name slug");

  res.json({ success: true, count: products.length, data: products });
});

exports.getBestSellers = catchAsync(async (req, res) => {
  const { game } = req.query;
  const filter = { bestSeller: true, active: true };
  if (game) filter.game = game;

  const products = await Product.find(filter)
    .sort("-salesCount")
    .limit(20)
    .populate("category", "name slug");

  res.json({ success: true, count: products.length, data: products });
});

exports.create = catchAsync(async (req, res, next) => {

  const cat = await Category.findById(req.body.category);
  if (!cat) return next(new AppError("Category not found", 404));

  if (!req.body.slug) {
    req.body.slug = req.body.name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }

  const images = parseArrayField(req.body.images);
  if (images) req.body.images = images;
  const features = parseArrayField(req.body.features);
  if (features) req.body.features = features;
  const notice = sanitizeNotice(req.body.notice);
  if (notice !== undefined) req.body.notice = notice;
  else delete req.body.notice;
  const variations = sanitizeVariations(req.body.variations);
  if (variations !== undefined) req.body.variations = variations;
  else delete req.body.variations;
  if (!req.body.imageUrl && images && images.length) req.body.imageUrl = images[0];
  req.body.imageShape = sanitizeImageShape(req.body.imageShape);

  const product = await Product.create(req.body);
  res.status(201).json({ success: true, data: product });
});

exports.update = catchAsync(async (req, res, next) => {
  const images = parseArrayField(req.body.images);
  if (images) req.body.images = images;
  const features = parseArrayField(req.body.features);
  if (features) req.body.features = features;
  // Present-but-unparseable means "cleared in the admin form" — reset to the
  // empty default rather than silently keeping the old value.
  if ("notice" in req.body) req.body.notice = sanitizeNotice(req.body.notice) || { text: "", required: false };
  if ("variations" in req.body) req.body.variations = sanitizeVariations(req.body.variations) || [];
  if (!req.body.imageUrl && images && images.length) req.body.imageUrl = images[0];
  // Absent keeps the stored shape; present-but-garbage falls back to square.
  if ("imageShape" in req.body) req.body.imageShape = sanitizeImageShape(req.body.imageShape);

  const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!product) return next(new AppError("Product not found", 404));
  res.json({ success: true, data: product });
});

exports.delete = catchAsync(async (req, res, next) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return next(new AppError("Product not found", 404));
  res.json({ success: true, message: "Product permanently deleted" });
});

exports.toggleStock = catchAsync(async (req, res, next) => {
  const product = await Product.findById(req.params.id);
  if (!product) return next(new AppError("Product not found", 404));

  product.outOfStock = !product.outOfStock;
  await product.save();

  res.json({ success: true, data: product });
});

exports.adminGetAll = catchAsync(async (req, res) => {
  const { search, game, activeStatus, page = 1, limit = 20, sort } = req.query;

  const filter = {};
  if (game) filter.game = game;
  if (activeStatus === "active") { filter.active = true; filter.outOfStock = false; }
  else if (activeStatus === "oos") { filter.outOfStock = true; }
  else if (activeStatus === "inactive") { filter.active = false; }

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { tags: { $in: [new RegExp(search, "i")] } },
    ];
  }

  const sortObj = sort === "price_asc" ? { price: 1 }
    : sort === "price_desc" ? { price: -1 }
    : sort === "name" ? { name: 1 }
    : sort === "sales" ? { salesCount: -1 }
    : { createdAt: -1 };

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [products, total] = await Promise.all([
    Product.find(filter).populate("category", "name slug").sort(sortObj).skip(skip).limit(parseInt(limit)),
    Product.countDocuments(filter),
  ]);

  res.json({ success: true, total, count: products.length, data: products });
});

exports.updateStockFields = catchAsync(async (req, res, next) => {
  const allowed = ["stock", "onHand", "outOfStock"];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (Object.keys(update).length === 0) {
    return next(new AppError("No valid fields to update", 400));
  }
  const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!product) return next(new AppError("Product not found", 404));
  res.json({ success: true, data: product });
});

exports.toggleActive = catchAsync(async (req, res, next) => {
  const product = await Product.findById(req.params.id);
  if (!product) return next(new AppError("Product not found", 404));
  product.active = !product.active;
  await product.save();
  res.json({ success: true, data: product });
});

exports.bulkCreate = catchAsync(async (req, res, next) => {
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) {
    return next(new AppError("products must be a non-empty array", 400));
  }
  if (products.length > 100) {
    return next(new AppError("Maximum 100 products per bulk create", 400));
  }

  const created = [];
  const errors = [];

  for (const [i, p] of products.entries()) {
    try {
      if (!p.slug) {
        p.slug = (p.name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      }
      const existing = await Product.findOne({ slug: p.slug });
      if (existing) p.slug = `${p.slug}-${Date.now()}-${i}`;
      p.imageShape = sanitizeImageShape(p.imageShape);
      const product = await Product.create(p);
      created.push(product);
    } catch (err) {
      errors.push({ index: i, name: p.name, error: err.message });
    }
  }

  res.status(201).json({
    success: true,
    data: { created, errors, total: created.length },
    message: `Created ${created.length} product${created.length !== 1 ? "s" : ""}${errors.length > 0 ? `, ${errors.length} failed` : ""}`,
  });
});
