const Game = require("../models/Game");
const Category = require("../models/Category");
const Product = require("../models/Product");
const { uploadToCloudinary, deleteFromCloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.listGames = catchAsync(async (req, res) => {
  const { active } = req.query;
  const filter = {};
  if (active !== undefined) filter.active = active === "true";

  const games = await Game.find(filter).sort({ sortOrder: 1, createdAt: -1 });

  const enriched = await Promise.all(
    games.map(async (g) => {
      const [productCount, categoryCount] = await Promise.all([
        Product.countDocuments({ game: g.slug, active: true }),
        Category.countDocuments({ game: g.slug }),
      ]);
      return { ...g.toObject(), productCount, categoryCount };
    })
  );

  res.json({ success: true, data: { games: enriched } });
});

exports.getGame = catchAsync(async (req, res, next) => {
  const game = await Game.findOne({ slug: req.params.slug });
  if (!game) return next(new AppError("Game not found", 404));

  const categories = await Category.find({ game: game.slug });
  const products = await Product.countDocuments({ game: game.slug, active: true });

  res.json({ success: true, data: { game, categories, productCount: products } });
});

exports.createGame = catchAsync(async (req, res, next) => {
  const { name, description, gradientFrom, gradientTo, sortOrder, featured } = req.body;
  if (!name) return next(new AppError("Game name is required", 400));

  const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const existing = await Game.findOne({ slug });
  if (existing) return next(new AppError("A game with this name already exists", 400));

  let imageUrl, imagePublicId, bannerUrl, bannerPublicId;

  if (req.files?.image?.[0]) {
    const result = await uploadToCloudinary(req.files.image[0].buffer, {
      folder: "rbstars/games",
      transformation: [{ width: 400, height: 400, crop: "fill" }],
    });
    imageUrl = result.secure_url;
    imagePublicId = result.public_id;
  }

  if (req.files?.banner?.[0]) {
    const result = await uploadToCloudinary(req.files.banner[0].buffer, {
      folder: "rbstars/banners",
      transformation: [{ width: 1200, height: 400, crop: "fill" }],
    });
    bannerUrl = result.secure_url;
    bannerPublicId = result.public_id;
  }

  const game = await Game.create({
    name: name.trim(),
    slug,
    description,
    imageUrl,
    imagePublicId,
    bannerUrl,
    bannerPublicId,
    gradient: {
      from: gradientFrom || "#1e3a5f",
      to: gradientTo || "#0f172a",
    },
    sortOrder: sortOrder || 0,
    featured: featured === "true" || featured === true,
  });

  res.status(201).json({ success: true, data: { game } });
});

exports.updateGame = catchAsync(async (req, res, next) => {
  const game = await Game.findOne({ slug: req.params.slug });
  if (!game) return next(new AppError("Game not found", 404));

  const { name, description, gradientFrom, gradientTo, sortOrder, featured, active, claimTeam, claimTime, claimSchedule } = req.body;

  if (name) game.name = name.trim();
  if (description !== undefined) game.description = description;
  if (gradientFrom) game.gradient.from = gradientFrom;
  if (gradientTo) game.gradient.to = gradientTo;
  if (sortOrder !== undefined) game.sortOrder = parseInt(sortOrder);
  if (featured !== undefined) game.featured = featured === "true" || featured === true;
  if (active !== undefined) game.active = active === "true" || active === true;
  if (claimTeam !== undefined) game.claimTeam = claimTeam;
  if (claimTime !== undefined) game.claimTime = Math.max(0, parseInt(claimTime) || 0);
  if (claimSchedule !== undefined) {
    try {
      const parsed = typeof claimSchedule === "string" ? JSON.parse(claimSchedule) : claimSchedule;
      if (Array.isArray(parsed)) game.claimSchedule = parsed;
    } catch {}
  }

  if (req.files?.image?.[0]) {
    await deleteFromCloudinary(game.imagePublicId);
    const result = await uploadToCloudinary(req.files.image[0].buffer, {
      folder: "rbstars/games",
      transformation: [{ width: 400, height: 400, crop: "fill" }],
    });
    game.imageUrl = result.secure_url;
    game.imagePublicId = result.public_id;
  }

  if (req.files?.banner?.[0]) {
    await deleteFromCloudinary(game.bannerPublicId);
    const result = await uploadToCloudinary(req.files.banner[0].buffer, {
      folder: "rbstars/banners",
      transformation: [{ width: 1200, height: 400, crop: "fill" }],
    });
    game.bannerUrl = result.secure_url;
    game.bannerPublicId = result.public_id;
  }

  await game.save();
  res.json({ success: true, data: { game } });
});

exports.deleteGame = catchAsync(async (req, res, next) => {
  const game = await Game.findOne({ slug: req.params.slug });
  if (!game) return next(new AppError("Game not found", 404));

  const productCount = await Product.countDocuments({ game: game.slug, active: true });
  if (productCount > 0) {
    return next(new AppError(`Cannot delete game with ${productCount} active products. Remove them first.`, 400));
  }

  if (game.imagePublicId) await deleteFromCloudinary(game.imagePublicId);
  if (game.bannerPublicId) await deleteFromCloudinary(game.bannerPublicId);

  await Category.deleteMany({ game: game.slug });
  await Game.deleteOne({ _id: game._id });

  res.json({ success: true, message: "Game deleted" });
});
