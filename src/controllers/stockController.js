const Stocker = require("../models/Stocker");
const StockRequest = require("../models/StockRequest");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const crypto = require("crypto");
const { sendInviteEmail } = require("../config/email");

exports.listStockers = catchAsync(async (req, res) => {
  const stockers = await Stocker.find({ active: true }).sort({ createdAt: -1 });

  const enriched = await Promise.all(
    stockers.map(async (s) => {
      const requestCount = await StockRequest.countDocuments({ stocker: s._id });
      const stockedCount = await StockRequest.countDocuments({ stocker: s._id, status: "stocked" });
      return { ...s.toObject(), requestCount, stockedCount };
    })
  );

  res.json({ success: true, data: { stockers: enriched } });
});

exports.getStockerDetail = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const requests = await StockRequest.find({ stocker: stocker._id })
    .sort({ createdAt: -1 })
    .limit(50);

  const stats = {
    totalRequests: requests.length,
    pendingRequests: requests.filter((r) => r.status === "pending").length,
    approvedRequests: requests.filter((r) => r.status === "approved").length,
    stockedRequests: requests.filter((r) => r.status === "stocked").length,
    rejectedRequests: requests.filter((r) => r.status === "rejected").length,
    totalRevenue: stocker.totalRevenue,
    totalCommission: stocker.totalCommission,
    totalStocked: stocker.totalStocked,
  };

  res.json({ success: true, data: { stocker, requests, stats } });
});

exports.inviteStocker = catchAsync(async (req, res, next) => {
  const { email, name, commissionRate, games } = req.body;
  if (!email) return next(new AppError("Email is required", 400));

  const existing = await Stocker.findOne({ email: email.toLowerCase() });
  if (existing) return next(new AppError("A stocker with this email already exists", 400));

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

  const stocker = await Stocker.create({
    email: email.toLowerCase(),
    name: name || "",
    inviteToken: hashedToken,
    inviteExpiry: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: "invited",
    commissionRate: commissionRate || 10,
    games: games || [],
  });

  const inviteUrl = `${process.env.FRONTEND_URL}/stocker/invite/${rawToken}`;

  try {
    await sendInviteEmail({
      to: email,
      inviteUrl,
      roleName: "Stocker",
      inviterName: req.panelUser?.email || "Admin",
    });
  } catch (emailErr) {
    console.error("Failed to send stocker invite email:", emailErr.message);
  }

  res.status(201).json({ success: true, data: { stocker } });
});

exports.updateStocker = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const { name, status, commissionRate, games } = req.body;
  if (name !== undefined) stocker.name = name;
  if (status) stocker.status = status;
  if (commissionRate !== undefined) stocker.commissionRate = commissionRate;
  if (games) stocker.games = games;

  await stocker.save();
  res.json({ success: true, data: { stocker } });
});

exports.deleteStocker = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));
  stocker.active = false;
  stocker.status = "disabled";
  await stocker.save();
  res.json({ success: true, message: "Stocker removed" });
});

exports.listRequests = catchAsync(async (req, res) => {
  const { status, stocker, game } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (stocker) filter.stocker = stocker;
  if (game) filter.game = game;

  const requests = await StockRequest.find(filter)
    .populate("stocker", "name email commissionRate")
    .sort({ createdAt: -1 })
    .limit(100);

  res.json({ success: true, data: { requests } });
});

exports.getRequest = catchAsync(async (req, res, next) => {
  const request = await StockRequest.findById(req.params.id).populate("stocker", "name email commissionRate");
  if (!request) return next(new AppError("Stock request not found", 404));
  res.json({ success: true, data: { request } });
});

exports.approveRequest = catchAsync(async (req, res, next) => {
  const { paymentAmount, adminNotes } = req.body;
  const request = await StockRequest.findById(req.params.id).populate("stocker");
  if (!request) return next(new AppError("Stock request not found", 404));
  if (request.status !== "pending") return next(new AppError("Request is not in pending status", 400));

  request.status = "approved";
  request.paymentAmount = paymentAmount || 0;
  request.approvedAt = new Date();
  if (adminNotes) request.adminNotes = adminNotes;

  await request.save();

  res.json({ success: true, data: { request } });
});

exports.markStocked = catchAsync(async (req, res, next) => {
  const { adminNotes } = req.body;
  const request = await StockRequest.findById(req.params.id).populate("stocker");
  if (!request) return next(new AppError("Stock request not found", 404));
  if (request.status !== "approved") return next(new AppError("Request must be approved before marking as stocked", 400));

  for (const item of request.items) {
    if (item.product) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity },
        outOfStock: false,
      });
    }
  }

  const commission = (request.totalSaleValue * (request.stocker?.commissionRate || 0)) / 100;

  request.status = "stocked";
  request.stockedAt = new Date();
  request.stockedBy = req.panelUser?.email || "Admin";
  request.commission = commission;
  request.commissionRate = request.stocker?.commissionRate || 0;
  if (adminNotes) request.adminNotes = adminNotes;
  request.paymentSent = true;

  await request.save();

  if (request.stocker) {
    await Stocker.findByIdAndUpdate(request.stocker._id, {
      $inc: {
        totalRevenue: request.totalSaleValue,
        totalCommission: commission,
        totalStocked: request.items.reduce((sum, i) => sum + i.quantity, 0),
      },
    });
  }

  res.json({ success: true, data: { request } });
});

exports.rejectRequest = catchAsync(async (req, res, next) => {
  const { adminNotes } = req.body;
  const request = await StockRequest.findById(req.params.id);
  if (!request) return next(new AppError("Stock request not found", 404));
  if (!["pending", "approved"].includes(request.status)) {
    return next(new AppError("Cannot reject a request in its current status", 400));
  }

  request.status = "rejected";
  request.rejectedAt = new Date();
  if (adminNotes) request.adminNotes = adminNotes;

  await request.save();
  res.json({ success: true, data: { request } });
});

exports.getStockerStats = catchAsync(async (req, res) => {
  const stockers = await Stocker.find({ active: true, status: "active" });

  const stats = await Promise.all(
    stockers.map(async (s) => {
      const [total, pending, stocked] = await Promise.all([
        StockRequest.countDocuments({ stocker: s._id }),
        StockRequest.countDocuments({ stocker: s._id, status: "pending" }),
        StockRequest.countDocuments({ stocker: s._id, status: "stocked" }),
      ]);
      return {
        stocker: { _id: s._id, name: s.name, email: s.email, commissionRate: s.commissionRate },
        totalRequests: total,
        pendingRequests: pending,
        stockedRequests: stocked,
        totalRevenue: s.totalRevenue,
        totalCommission: s.totalCommission,
      };
    })
  );

  res.json({ success: true, data: { stats } });
});
