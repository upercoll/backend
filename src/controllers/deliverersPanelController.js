const crypto = require("crypto");
const Deliverer = require("../models/Deliverer");
const DeliveryRecord = require("../models/DeliveryRecord");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendInviteEmail } = require("../config/email");

exports.listDeliverers = catchAsync(async (req, res) => {
  const deliverers = await Deliverer.find({ active: true }).sort({ createdAt: -1 });
  const enriched = await Promise.all(
    deliverers.map(async (d) => {
      const deliveryCount = await DeliveryRecord.countDocuments({ deliverer: d._id });
      const unpaidCount = await DeliveryRecord.countDocuments({ deliverer: d._id, paidOut: false });
      return { ...d.toObject(), deliveryCount, unpaidCount };
    })
  );
  res.json({ success: true, data: { deliverers: enriched } });
});

exports.getDelivererDetail = catchAsync(async (req, res, next) => {
  const deliverer = await Deliverer.findById(req.params.id);
  if (!deliverer) return next(new AppError("Deliverer not found", 404));

  const records = await DeliveryRecord.find({ deliverer: deliverer._id })
    .sort({ deliveredAt: -1 })
    .limit(100);

  const unpaidRecords = records.filter((r) => !r.paidOut);
  const stats = {
    totalDeliveries: records.length,
    unpaidDeliveries: unpaidRecords.length,
    totalRevenue: deliverer.totalRevenue,
    totalCommission: deliverer.totalCommission,
    lifetimeRevenue: deliverer.lifetimeRevenue,
    lifetimeCommission: deliverer.lifetimeCommission,
  };

  res.json({ success: true, data: { deliverer, records, stats } });
});

exports.inviteDeliverer = catchAsync(async (req, res, next) => {
  const { email, name, commissionRate, games } = req.body;
  if (!email) return next(new AppError("Email is required", 400));

  const existing = await Deliverer.findOne({ email: email.toLowerCase() });
  if (existing) return next(new AppError("A deliverer with this email already exists", 400));

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

  const deliverer = await Deliverer.create({
    email: email.toLowerCase(),
    name: name || "",
    inviteToken: hashedToken,
    inviteExpiry: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: "invited",
    commissionRate: commissionRate ?? 20,
    games: Array.isArray(games) ? games : [],
  });

  const inviteUrl = `${process.env.FRONTEND_URL}/deliverer/invite/${rawToken}`;
  try {
    await sendInviteEmail({
      to: email,
      inviteUrl,
      roleName: "Delivery Team",
      inviterName: req.panelUser?.email || "Admin",
    });
  } catch (err) {
    console.error("Failed to send deliverer invite email:", err.message);
  }

  res.status(201).json({ success: true, data: { deliverer } });
});

exports.updateDeliverer = catchAsync(async (req, res, next) => {
  const deliverer = await Deliverer.findById(req.params.id);
  if (!deliverer) return next(new AppError("Deliverer not found", 404));

  const { name, status, commissionRate, games } = req.body;
  if (name !== undefined) deliverer.name = name;
  if (status) deliverer.status = status;
  if (commissionRate !== undefined) deliverer.commissionRate = commissionRate;
  if (games !== undefined) deliverer.games = Array.isArray(games) ? games : [];

  await deliverer.save();
  res.json({ success: true, data: { deliverer } });
});

// Mark all unpaid deliveries as paid — resets tracking totals
exports.markPaid = catchAsync(async (req, res, next) => {
  const deliverer = await Deliverer.findById(req.params.id);
  if (!deliverer) return next(new AppError("Deliverer not found", 404));

  const paidRevenue = deliverer.totalRevenue;
  const paidCommission = deliverer.totalCommission;

  // Mark all unpaid records as paid
  await DeliveryRecord.updateMany(
    { deliverer: deliverer._id, paidOut: false },
    { $set: { paidOut: true } }
  );

  // Reset unpaid tracking totals
  deliverer.totalRevenue = 0;
  deliverer.totalCommission = 0;
  deliverer.lastPayoutAt = new Date();
  await deliverer.save();

  res.json({
    success: true,
    data: { paidRevenue, paidCommission, lastPayoutAt: deliverer.lastPayoutAt },
  });
});

exports.deleteDeliverer = catchAsync(async (req, res, next) => {
  const deliverer = await Deliverer.findById(req.params.id);
  if (!deliverer) return next(new AppError("Deliverer not found", 404));
  deliverer.active = false;
  deliverer.status = "disabled";
  await deliverer.save();
  res.json({ success: true, message: "Deliverer disabled" });
});
