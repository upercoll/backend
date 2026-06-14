const PromoCode = require("../models/PromoCode");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.validate = catchAsync(async (req, res, next) => {
  const { code, email, orderTotal } = req.body;

  if (!code?.trim()) return next(new AppError("Promo code is required", 400));

  const promo = await PromoCode.findOne({
    code: code.trim().toUpperCase(),
    active: true,
  });

  if (!promo) {
    return next(new AppError("Invalid or expired promo code", 400));
  }

  const now = new Date();
  if (promo.startsAt && now < promo.startsAt) {
    return next(new AppError("This promo code is not active yet", 400));
  }
  if (promo.expiresAt && now > promo.expiresAt) {
    return next(new AppError("This promo code has expired", 400));
  }

  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    return next(new AppError("This promo code has reached its usage limit", 400));
  }

  if (email && promo.maxUsesPerUser !== null) {
    const userUses = promo.usedBy.filter((u) => u.email === email.toLowerCase()).length;
    if (userUses >= promo.maxUsesPerUser) {
      return next(new AppError("You have already used this promo code", 400));
    }
  }

  if (orderTotal && promo.minOrderValue > 0 && orderTotal < promo.minOrderValue) {
    return next(
      new AppError(
        `Minimum order of $${promo.minOrderValue.toFixed(2)} required for this code`,
        400
      )
    );
  }

  let discountAmount = 0;
  if (promo.discountType === "percent") {
    discountAmount = orderTotal ? (orderTotal * promo.discountValue) / 100 : null;
  } else {
    discountAmount = promo.discountValue;
  }

  res.json({
    success: true,
    data: {
      code: promo.code,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      discountAmount,
      description: promo.description,
    },
  });
});

exports.getAll = catchAsync(async (req, res) => {
  const promos = await PromoCode.find()
    .sort("-createdAt")
    .select("-usedBy");

  res.json({ success: true, count: promos.length, data: promos });
});

exports.getOne = catchAsync(async (req, res, next) => {
  const promo = await PromoCode.findById(req.params.id);
  if (!promo) return next(new AppError("Promo code not found", 404));
  res.json({ success: true, data: promo });
});

exports.create = catchAsync(async (req, res, next) => {
  const {
    code, description, discountType, discountValue,
    minOrderValue, maxUses, maxUsesPerUser, startsAt, expiresAt,
  } = req.body;

  if (discountType === "percent" && discountValue > 100) {
    return next(new AppError("Percent discount cannot exceed 100%", 400));
  }

  const promo = await PromoCode.create({
    code: code.toUpperCase(),
    description,
    discountType,
    discountValue,
    minOrderValue: minOrderValue || 0,
    maxUses: maxUses || null,
    maxUsesPerUser: maxUsesPerUser || null,
    startsAt: startsAt || null,
    expiresAt: expiresAt || null,
    createdBy: req.panelUser.id,
  });

  res.status(201).json({ success: true, data: promo });
});

exports.update = catchAsync(async (req, res, next) => {
  const allowed = ["description", "discountType", "discountValue", "minOrderValue", "maxUses", "maxUsesPerUser", "startsAt", "expiresAt", "active"];
  const update = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

  const promo = await PromoCode.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!promo) return next(new AppError("Promo code not found", 404));
  res.json({ success: true, data: promo });
});

exports.delete = catchAsync(async (req, res, next) => {
  const promo = await PromoCode.findByIdAndDelete(req.params.id);
  if (!promo) return next(new AppError("Promo code not found", 404));
  res.json({ success: true, message: "Promo code deleted" });
});

exports.getStats = catchAsync(async (req, res, next) => {
  const promo = await PromoCode.findById(req.params.id);
  if (!promo) return next(new AppError("Promo code not found", 404));

  res.json({
    success: true,
    data: {
      code: promo.code,
      usedCount: promo.usedCount,
      maxUses: promo.maxUses,
      recentUses: promo.usedBy.slice(-20).reverse(),
    },
  });
});
