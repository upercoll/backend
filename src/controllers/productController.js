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
