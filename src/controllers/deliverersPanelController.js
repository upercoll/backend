const crypto = require("crypto");
const Deliverer = require("../models/Deliverer");
const DeliveryRecord = require("../models/DeliveryRecord");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendInviteEmail } = require("../config/email");

function calculateUnpaidDeliveryTotals(records) {
  return records.reduce(
    (totals, record) => {
      const commissionDue = Math.max(0, (record.commission || 0) - (record.paidAmount || 0));
      if (commissionDue <= 0) return totals;
      totals.commission += commissionDue;
      totals.revenue += (record.orderTotal || 0) * (commissionDue / (record.commission || 1));
      totals.count += 1;
      return totals;
    },
    { commission: 0, revenue: 0, count: 0 }
  );
}

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

  const unpaidTotals = calculateUnpaidDeliveryTotals(records);
  const delivererData = deliverer.toObject();
  // Record-level amounts are the source of truth for partial payouts.
  delivererData.totalRevenue = Number(unpaidTotals.revenue.toFixed(2));
  delivererData.totalCommission = Number(unpaidTotals.commission.toFixed(2));
  const stats = {
    totalDeliveries: records.length,
    unpaidDeliveries: unpaidTotals.count,
    totalRevenue: delivererData.totalRevenue,
    totalCommission: delivererData.totalCommission,
    lifetimeRevenue: deliverer.lifetimeRevenue,
    lifetimeCommission: deliverer.lifetimeCommission,
  };

  res.json({ success: true, data: { deliverer: delivererData, records, stats } });
});

function normalizeAssignments(assignments, fallbackRate) {
  if (assignments === undefined) return undefined;
  if (!Array.isArray(assignments)) throw new AppError("Assignments must be a list of games and commission rates", 400);

  const seenGames = new Set();
  return assignments.map((assignment) => {
    const game = String(
      typeof assignment === "string" ? assignment : assignment?.game || ""
    ).trim();
    const rawRate = typeof assignment === "string" ? fallbackRate : assignment?.commissionRate;
    const commissionRate = Number(rawRate);
    if (!game) throw new AppError("Every assignment must include a game", 400);
    if (seenGames.has(game)) throw new AppError("A game can only be assigned once", 400);
    if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) {
      throw new AppError("Each game commission rate must be between 0 and 100", 400);
    }
    seenGames.add(game);
    // Return a plain object so Mongoose does not retain an older subdocument
    // value when an assignment's rate has been edited.
    return { game, commissionRate: Number(commissionRate.toFixed(2)) };
  });
}

exports.inviteDeliverer = catchAsync(async (req, res, next) => {
  const { email, name, commissionRate, assignments, games } = req.body;
  if (!email) return next(new AppError("Email is required", 400));

  const existing = await Deliverer.findOne({ email: email.toLowerCase() });
  if (existing) return next(new AppError("A deliverer with this email already exists", 400));

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

  const assignmentInput = assignments !== undefined
    ? assignments
    : (Array.isArray(games) ? games.map((game) => ({ game, commissionRate: commissionRate ?? 20 })) : undefined);
  const normalizedAssignments = normalizeAssignments(assignmentInput, commissionRate ?? 20) || [];

  const deliverer = await Deliverer.create({
    email: email.toLowerCase(),
    name: name || "",
    inviteToken: hashedToken,
    inviteExpiry: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: "invited",
    commissionRate: commissionRate ?? 20,
    assignments: normalizedAssignments,
    games: normalizedAssignments.map((assignment) => assignment.game),
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

  const { name, status, commissionRate, assignments, games } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (status) updates.status = status;
  if (commissionRate !== undefined) updates.commissionRate = commissionRate;

  const effectiveRate = commissionRate !== undefined
    ? Number(commissionRate)
    : Number(deliverer.commissionRate ?? 20);
  const assignmentInput = assignments !== undefined
    ? assignments
    : (Array.isArray(games) ? games.map((game) => ({ game, commissionRate: effectiveRate })) : undefined);
  if (assignmentInput !== undefined) {
    const normalizedAssignments = normalizeAssignments(assignmentInput, effectiveRate);
    // Save both representations in the same update. The assignment modal
    // sends `assignments`, while other delivery flows still read `games`.
    updates.assignments = normalizedAssignments;
    updates.games = normalizedAssignments.map((assignment) => assignment.game);
  }

  const updatedDeliverer = await Deliverer.findOneAndUpdate(
    { _id: deliverer._id },
    { $set: updates },
    { new: true, runValidators: true }
  );

  res.json({ success: true, data: { deliverer: updatedDeliverer } });
});

// Mark deliveries as paid — supports paying a partial amount, allocated
// oldest-first across unpaid delivery records.
exports.markPaid = catchAsync(async (req, res, next) => {
  const deliverer = await Deliverer.findById(req.params.id);
  if (!deliverer) return next(new AppError("Deliverer not found", 404));

  const records = await DeliveryRecord.find({ deliverer: deliverer._id, paidOut: false }).sort({ deliveredAt: 1 });
  const owed = Number(calculateUnpaidDeliveryTotals(records).commission.toFixed(2));
  const requestedAmount = req.body?.amount === undefined ? owed : Number(req.body.amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > owed + 0.001) {
    return next(new AppError(`Enter an amount between $0.01 and $${owed.toFixed(2)}`, 400));
  }

  let remaining = Number(requestedAmount.toFixed(2));
  let paidRevenue = 0;
  for (const record of records) {
    if (remaining <= 0) break;
    const due = Math.max(0, (record.commission || 0) - (record.paidAmount || 0));
    const allocation = Number(Math.min(due, remaining).toFixed(2));
    if (!allocation) continue;
    record.paidAmount = Number(((record.paidAmount || 0) + allocation).toFixed(2));
    if (record.paidAmount + 0.001 >= (record.commission || 0)) record.paidOut = true;
    paidRevenue += (record.orderTotal || 0) * (allocation / (record.commission || 1));
    remaining = Number((remaining - allocation).toFixed(2));
    await record.save();
  }

  const remainingRecords = await DeliveryRecord.find({ deliverer: deliverer._id, paidOut: false });
  const remainingTotals = calculateUnpaidDeliveryTotals(remainingRecords);
  deliverer.totalCommission = Number(remainingTotals.commission.toFixed(2));
  deliverer.totalRevenue = Number(remainingTotals.revenue.toFixed(2));
  deliverer.lastPayoutAt = new Date();
  await deliverer.save();

  res.json({
    success: true,
    data: {
      paidRevenue: Number(paidRevenue.toFixed(2)),
      paidCommission: requestedAmount,
      remainingCommission: deliverer.totalCommission,
      remainingRevenue: deliverer.totalRevenue,
      lastPayoutAt: deliverer.lastPayoutAt,
    },
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
