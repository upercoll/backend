const Tutorial = require("../models/Tutorial");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.listTutorials = catchAsync(async (req, res) => {
  const { game, active } = req.query;
  const filter = {};
  if (game) filter.game = game;
  if (active !== undefined) filter.active = active === "true";

  const tutorials = await Tutorial.find(filter).sort({ sortOrder: 1, createdAt: -1 });
  res.json({ success: true, data: { tutorials } });
});

exports.createTutorial = catchAsync(async (req, res, next) => {
  const { game, title, description, videoUrl, thumbnailUrl, gradient, sortOrder } = req.body;
  if (!game || !title) return next(new AppError("Game and title are required", 400));

  const tutorial = await Tutorial.create({ game, title, description, videoUrl, thumbnailUrl, gradient, sortOrder });
  res.status(201).json({ success: true, data: { tutorial } });
});

exports.updateTutorial = catchAsync(async (req, res, next) => {
  const tutorial = await Tutorial.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!tutorial) return next(new AppError("Tutorial not found", 404));
  res.json({ success: true, data: { tutorial } });
});

exports.deleteTutorial = catchAsync(async (req, res, next) => {
  const tutorial = await Tutorial.findByIdAndDelete(req.params.id);
  if (!tutorial) return next(new AppError("Tutorial not found", 404));
  res.json({ success: true, message: "Tutorial deleted" });
});

exports.reorderTutorials = catchAsync(async (req, res, next) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return next(new AppError("Order must be an array", 400));

  await Promise.all(
    order.map(({ id, sortOrder }) => Tutorial.findByIdAndUpdate(id, { sortOrder }))
  );
  res.json({ success: true, message: "Tutorials reordered" });
});
