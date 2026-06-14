const ProofOfDelivery = require("../models/ProofOfDelivery");
const ClaimSession = require("../models/ClaimSession");
const AgentStats = require("../models/AgentStats");
const { uploadToCloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { getIO } = require("../config/socket");

exports.submitProof = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError("Proof image is required", 400));

  const { roomId, estimatedDelivery, notes } = req.body;
  if (!roomId || !estimatedDelivery) {
    return next(new AppError("Room ID and estimated delivery time are required", 400));
  }

  const session = await ClaimSession.findOne({ roomId });
  if (!session) return next(new AppError("Claim session not found", 404));

  const result = await uploadToCloudinary(req.file.buffer, {
    folder: "rbstars/proofs",
    transformation: [{ width: 1200, quality: "auto" }],
  });

  const proof = await ProofOfDelivery.create({
    claimSessionId: session._id,
    roomId,
    orderRef: session.orderRef,
    agentId: req.panelUser.id,
    agentName: req.panelUser.member?.displayName || req.panelUser.email,
    proofImageUrl: result.secure_url,
    proofImagePublicId: result.public_id,
    estimatedDelivery,
    notes,
    customerEmail: session.contactEmail,
    robloxUsername: session.robloxUsername,
    game: session.game,
  });

  await AgentStats.findOneAndUpdate(
    { agentId: req.panelUser.id },
    { $inc: { completedClaims: 1 } },
    { upsert: true }
  );

  try {
    const io = getIO();
    io.to("admin-room").emit("admin:proof_submitted", {
      proof: proof.toObject(),
      agentName: proof.agentName,
      game: session.game,
    });
  } catch {
  }

  res.status(201).json({ success: true, data: { proof } });
});

exports.listProofs = catchAsync(async (req, res) => {
  const { viewed, agentId, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (viewed !== undefined) filter.viewedByOwner = viewed === "true";
  if (agentId) filter.agentId = agentId;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [proofs, total] = await Promise.all([
    ProofOfDelivery.find(filter)
      .populate({ path: "agentId", select: "email claimGames" })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    ProofOfDelivery.countDocuments(filter),
  ]);

  const unviewedCount = await ProofOfDelivery.countDocuments({ viewedByOwner: false });

  res.json({
    success: true,
    data: { proofs, total, unviewedCount, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
  });
});

exports.getProof = catchAsync(async (req, res, next) => {
  const proof = await ProofOfDelivery.findById(req.params.id).populate({ path: "agentId", select: "email claimGames" });
  if (!proof) return next(new AppError("Proof not found", 404));

  if (!proof.viewedByOwner) {
    proof.viewedByOwner = true;
    proof.viewedAt = new Date();
    await proof.save();
  }

  res.json({ success: true, data: { proof } });
});

exports.addOwnerNotes = catchAsync(async (req, res, next) => {
  const { notes } = req.body;
  const proof = await ProofOfDelivery.findByIdAndUpdate(
    req.params.id,
    { ownerNotes: notes, viewedByOwner: true, viewedAt: new Date() },
    { new: true }
  );
  if (!proof) return next(new AppError("Proof not found", 404));
  res.json({ success: true, data: { proof } });
});
