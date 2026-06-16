const Product = require("../models/Product");
const Category = require("../models/Category");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const APIFeatures = require("../utils/apiFeatures");

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

  res.json({ success: true, data: product });
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

  const product = await Product.create(req.body);
  res.status(201).json({ success: true, data: product });
});

exports.update = catchAsync(async (req, res, next) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!product) return next(new AppError("Product not found", 404));
  res.json({ success: true, data: product });
});

exports.delete = catchAsync(async (req, res, next) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { active: false },
    { new: true }
  );
  if (!product) return next(new AppError("Product not found", 404));
  res.json({ success: true, message: "Product deleted" });
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
