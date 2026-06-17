const crypto = require("crypto");
const Collaborator = require("../models/Collaborator");
const CollaboratorProduct = require("../models/CollaboratorProduct");
const CollaboratorPayout = require("../models/CollaboratorPayout");
const Product = require("../models/Product");
const Order = require("../models/Order");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendCollabInviteEmail, sendCollabVerificationEmail } = require("../config/email");
const jwt = require("jsonwebtoken");

function signCollabToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || "collab_secret_key", { expiresIn: "30d" });
}

async function getUnpaidSales(collaborator) {
  const collabProducts = await CollaboratorProduct.find({ collaborator: collaborator._id, active: true });
  if (collabProducts.length === 0) return { sales: [], total: 0 };

  const productIdMap = {};
  collabProducts.forEach(cp => { productIdMap[String(cp.product)] = cp; });
  const productIds = collabProducts.map(cp => cp.product);

  const paidStatuses = ["paid", "delivering", "completed", "partially_refunded"];
  const sinceDate = collaborator.lastPayoutAt || new Date(0);

  const orders = await Order.find({
    status: { $in: paidStatuses },
    "payment.status": "succeeded",
    "items.product": { $in: productIds },
    createdAt: { $gt: sinceDate },
  });

  const sales = [];
  let total = 0;

  for (const order of orders) {
    for (const item of order.items) {
      const cp = productIdMap[String(item.product)];
      if (!cp) continue;
      const earnings = parseFloat(((item.unitPrice * item.quantity) * (cp.cut / 100)).toFixed(2));
      total += earnings;
      sales.push({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        orderDate: order.createdAt,
        productId: String(item.product),
        productName: item.productSnapshot?.name || cp.productName || "Unknown",
        sku: item.productSnapshot?.sku || "-",
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        orderTotal: item.totalPrice,
        cut: cp.cut,
        earnings,
      });
    }
  }

  return { sales, total: parseFloat(total.toFixed(2)) };
}

exports.listCollaborators = catchAsync(async (req, res) => {
  const collabs = await Collaborator.find().sort({ createdAt: -1 });

  const enriched = await Promise.all(
    collabs.map(async (c) => {
      const productCount = await CollaboratorProduct.countDocuments({ collaborator: c._id, active: true });
      const lastPayout = await CollaboratorPayout.findOne({ collaborator: c._id, status: "paid" }).sort({ paidAt: -1 });
      return {
        ...c.toSafeObject(),
        productCount,
        lastPayoutAt: lastPayout?.paidAt || null,
        lastPayoutAmount: lastPayout?.amount || null,
      };
    })
  );

  res.json({ success: true, data: { collaborators: enriched } });
});

exports.getCollaborator = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  const products = await CollaboratorProduct.find({ collaborator: collab._id }).populate("product", "name slug imageUrl gradient price");
  const payouts = await CollaboratorPayout.find({ collaborator: collab._id }).sort({ createdAt: -1 });
  const { sales, total } = await getUnpaidSales(collab);

  res.json({
    success: true,
    data: {
      collaborator: collab.toSafeObject(),
      products,
      payouts,
      unpaidSales: sales,
      unpaidTotal: total,
    },
  });
});

exports.inviteCollaborator = catchAsync(async (req, res, next) => {
  const { name, email } = req.body;
  if (!name || !email) return next(new AppError("Name and email are required", 400));

  const existing = await Collaborator.findOne({ email: email.toLowerCase() });
  if (existing) {
    if (existing.status === "active") return next(new AppError("This email is already an active collaborator", 400));
    const rawToken = existing.generateInviteToken();
    await existing.save({ validateBeforeSave: false });
    const inviteUrl = `${process.env.FRONTEND_URL}/collab/invite/${rawToken}`;
    const inviterName = req.panelUser?.email || "The site owner";
    await sendCollabInviteEmail({ to: email, inviteUrl, name: existing.name, inviterName });
    return res.json({ success: true, message: "Re-invite sent", data: { collaborator: existing.toSafeObject() } });
  }

  const collab = new Collaborator({
    name: name.trim(),
    email: email.toLowerCase(),
    invitedBy: req.panelUser?.email || "Admin",
  });

  const rawToken = collab.generateInviteToken();
  await collab.save();

  const inviteUrl = `${process.env.FRONTEND_URL}/collab/invite/${rawToken}`;
  const inviterName = req.panelUser?.email || "The site owner";
  await sendCollabInviteEmail({ to: email, inviteUrl, name: collab.name, inviterName });

  res.status(201).json({
    success: true,
    message: "Collaboration invite sent",
    data: { collaborator: collab.toSafeObject() },
  });
});

exports.deleteCollaborator = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  await CollaboratorProduct.deleteMany({ collaborator: collab._id });
  await Collaborator.findByIdAndDelete(collab._id);

  res.json({ success: true, message: "Collaborator removed" });
});

exports.addProduct = catchAsync(async (req, res, next) => {
  const { productId, cut } = req.body;
  if (!productId || cut === undefined) return next(new AppError("productId and cut are required", 400));
  if (cut < 0 || cut > 100) return next(new AppError("Cut must be between 0 and 100", 400));

  const collab = await Collaborator.findById(req.params.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  const product = await Product.findById(productId);
  if (!product) return next(new AppError("Product not found", 404));

  const existing = await CollaboratorProduct.findOne({ collaborator: collab._id, product: productId });
  if (existing) return next(new AppError("This product is already assigned to this collaborator", 400));

  const cp = await CollaboratorProduct.create({
    collaborator: collab._id,
    product: productId,
    productName: product.name,
    productSlug: product.slug,
    cut: parseFloat(cut),
  });

  res.status(201).json({ success: true, data: { collabProduct: cp } });
});

exports.updateProduct = catchAsync(async (req, res, next) => {
  const { cut } = req.body;
  if (cut === undefined) return next(new AppError("cut is required", 400));
  if (cut < 0 || cut > 100) return next(new AppError("Cut must be between 0 and 100", 400));

  const cp = await CollaboratorProduct.findOneAndUpdate(
    { _id: req.params.cpId, collaborator: req.params.id },
    { cut: parseFloat(cut) },
    { new: true }
  ).populate("product", "name slug imageUrl gradient price");

  if (!cp) return next(new AppError("Assignment not found", 404));

  res.json({ success: true, data: { collabProduct: cp } });
});

exports.removeProduct = catchAsync(async (req, res, next) => {
  const cp = await CollaboratorProduct.findOneAndDelete({
    _id: req.params.cpId,
    collaborator: req.params.id,
  });
  if (!cp) return next(new AppError("Assignment not found", 404));

  res.json({ success: true, message: "Product removed from collaborator" });
});

exports.listPayouts = catchAsync(async (req, res) => {
  const payouts = await CollaboratorPayout.find()
    .populate("collaborator", "name email")
    .sort({ createdAt: -1 });

  res.json({ success: true, data: { payouts } });
});

exports.getCollaboratorPayouts = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  const payouts = await CollaboratorPayout.find({ collaborator: collab._id }).sort({ createdAt: -1 });
  const { sales, total } = await getUnpaidSales(collab);

  res.json({
    success: true,
    data: {
      collaborator: collab.toSafeObject(),
      payouts,
      unpaidSales: sales,
      unpaidTotal: total,
    },
  });
});

exports.getPayoutDetail = catchAsync(async (req, res, next) => {
  const payout = await CollaboratorPayout.findById(req.params.payoutId)
    .populate("collaborator", "name email");
  if (!payout) return next(new AppError("Payout not found", 404));

  res.json({ success: true, data: { payout } });
});

exports.markPayoutPaid = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  const { sales, total } = await getUnpaidSales(collab);

  if (total <= 0 || sales.length === 0) {
    return next(new AppError("No unpaid sales found for this collaborator", 400));
  }

  const now = new Date();
  const payout = await CollaboratorPayout.create({
    collaborator: collab._id,
    status: "paid",
    amount: total,
    periodStart: collab.lastPayoutAt || new Date(0),
    periodEnd: now,
    paidAt: now,
    paidBy: req.panelUser?.email || "Admin",
    sales,
  });

  collab.lastPayoutAt = now;
  await collab.save({ validateBeforeSave: false });

  res.json({ success: true, data: { payout }, message: `Payout of $${total.toFixed(2)} marked as paid` });
});

exports.getAvailableProducts = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  const assigned = await CollaboratorProduct.find({ collaborator: collab._id }).select("product");
  const assignedIds = assigned.map(cp => String(cp.product));

  const products = await Product.find({ active: true }).select("name slug imageUrl gradient price game").sort({ name: 1 });
  const available = products.filter(p => !assignedIds.includes(String(p._id)));

  res.json({ success: true, data: { products: available } });
});

exports.validateInviteToken = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const collab = await Collaborator.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  });

  if (!collab) return next(new AppError("Invite link is invalid or has expired", 400));

  res.json({ success: true, data: { email: collab.email, name: collab.name, collaboratorId: collab._id } });
});

exports.sendVerificationCode = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const collab = await Collaborator.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  });
  if (!collab) return next(new AppError("Invite expired or invalid", 400));

  const code = collab.generateVerificationCode();
  await collab.save({ validateBeforeSave: false });

  await sendCollabVerificationEmail({ to: collab.email, code });

  res.json({ success: true, message: "Verification code sent to your email" });
});

exports.verifyAndActivate = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { code, password } = req.body;

  if (!code || !password) return next(new AppError("Code and password are required", 400));
  if (password.length < 8) return next(new AppError("Password must be at least 8 characters", 400));

  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const collab = await Collaborator.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  }).select("+verificationCode");

  if (!collab) return next(new AppError("Invite expired or invalid", 400));
  if (collab.verificationCode !== code) return next(new AppError("Invalid verification code", 400));
  if (!collab.verificationExpiry || collab.verificationExpiry < new Date()) {
    return next(new AppError("Verification code expired", 400));
  }

  collab.password = password;
  collab.status = "active";
  collab.inviteToken = undefined;
  collab.inviteExpiry = undefined;
  collab.verificationCode = undefined;
  collab.verificationExpiry = undefined;
  await collab.save();

  const collabToken = signCollabToken({ id: collab._id, type: "collaborator", email: collab.email });

  res.json({
    success: true,
    token: collabToken,
    data: { collaborator: collab.toSafeObject() },
  });
});

exports.collabLogin = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return next(new AppError("Email and password required", 400));

  const collab = await Collaborator.findOne({ email: email.toLowerCase() }).select("+password");
  if (!collab || !collab.active || collab.status !== "active") {
    return next(new AppError("Invalid credentials or account not activated", 401));
  }
  if (!collab.password) return next(new AppError("Please use the invite link to set up your account", 400));
  if (!(await collab.comparePassword(password))) return next(new AppError("Invalid credentials", 401));

  collab.lastLogin = new Date();
  await collab.save({ validateBeforeSave: false });

  const collabToken = signCollabToken({ id: collab._id, type: "collaborator", email: collab.email });

  res.json({ success: true, token: collabToken, data: { collaborator: collab.toSafeObject() } });
});

exports.collabMe = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.collabUser.id);
  if (!collab) return next(new AppError("Collaborator not found", 404));

  const products = await CollaboratorProduct.find({ collaborator: collab._id, active: true })
    .populate("product", "name slug imageUrl gradient price game");

  const paidStatuses = ["paid", "delivering", "completed", "partially_refunded"];
  const productIdMap = {};
  products.forEach(cp => { productIdMap[String(cp.product?._id || cp.product)] = cp; });
  const productIds = products.map(cp => cp.product?._id || cp.product);

  const orders = await Order.find({
    status: { $in: paidStatuses },
    "payment.status": "succeeded",
    "items.product": { $in: productIds },
  }).sort({ createdAt: -1 });

  const sales = [];
  let totalEarnings = 0;
  let unpaidEarnings = 0;
  const sinceDate = collab.lastPayoutAt || new Date(0);

  for (const order of orders) {
    for (const item of order.items) {
      const cp = productIdMap[String(item.product)];
      if (!cp) continue;
      const earnings = parseFloat(((item.unitPrice * item.quantity) * (cp.cut / 100)).toFixed(2));
      totalEarnings += earnings;
      const isUnpaid = order.createdAt > sinceDate;
      if (isUnpaid) unpaidEarnings += earnings;
      sales.push({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        orderDate: order.createdAt,
        productName: item.productSnapshot?.name || cp.productName || "Unknown",
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        earnings,
        isPaid: !isUnpaid,
      });
    }
  }

  res.json({
    success: true,
    data: {
      collaborator: collab.toSafeObject(),
      products,
      sales: sales.slice(0, 100),
      totalEarnings: parseFloat(totalEarnings.toFixed(2)),
      unpaidEarnings: parseFloat(unpaidEarnings.toFixed(2)),
    },
  });
});
