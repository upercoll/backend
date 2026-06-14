const Category = require("../models/Category");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getAll = catchAsync(async (req, res) => {
  const filter = { active: true };
  if (req.query.game) filter.game = req.query.game;

  const categories = await Category.find(filter).sort("sortOrder name");
  res.json({ success: true, count: categories.length, data: categories });
});

exports.getByGame = catchAsync(async (req, res) => {
  const categories = await Category.find({
    game: req.params.game,
    active: true,
  }).sort("sortOrder name");

  res.json({ success: true, count: categories.length, data: categories });
});

exports.getOne = catchAsync(async (req, res, next) => {
  const cat = await Category.findOne({
    $or: [{ _id: req.params.id }, { slug: req.params.id }],
    active: true,
  });
  if (!cat) return next(new AppError("Category not found", 404));
  res.json({ success: true, data: cat });
});

exports.create = catchAsync(async (req, res) => {
  if (!req.body.slug) {
    req.body.slug = req.body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }
  const cat = await Category.create(req.body);
  res.status(201).json({ success: true, data: cat });
});

exports.update = catchAsync(async (req, res, next) => {
  const cat = await Category.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!cat) return next(new AppError("Category not found", 404));
  res.json({ success: true, data: cat });
});

exports.delete = catchAsync(async (req, res, next) => {
  const cat = await Category.findByIdAndUpdate(
    req.params.id,
    { active: false },
    { new: true }
  );
  if (!cat) return next(new AppError("Category not found", 404));
  res.json({ success: true, message: "Category deleted" });
});

exports.addSubcategory = catchAsync(async (req, res, next) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) return next(new AppError("Category not found", 404));

  if (!req.body.slug) {
    req.body.slug = req.body.name.toLowerCase().replace(/\s+/g, "-");
  }
  cat.subcategories.push(req.body);
  await cat.save();
  res.json({ success: true, data: cat });
});

exports.removeSubcategory = catchAsync(async (req, res, next) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) return next(new AppError("Category not found", 404));

  cat.subcategories = cat.subcategories.filter(
    (s) => s._id.toString() !== req.params.subId
  );
  await cat.save();
  res.json({ success: true, data: cat });
});
