const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const Stocker = require("../models/Stocker");
const AppError = require("../utils/AppError");
const stockerAuthCtrl = require("../controllers/stockerAuthController");
const stockerPanelCtrl = require("../controllers/stockerPanelController");

async function stockerAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return next(new AppError("Not authenticated", 401));
    const token = header.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return next(new AppError("Invalid or expired token", 401));
    }
    if (decoded.type !== "stocker") return next(new AppError("Invalid token type", 401));
    const stocker = await Stocker.findById(decoded.id);
    if (!stocker || stocker.status !== "active") return next(new AppError("Account inactive", 401));
    req.stocker = stocker;
    next();
  } catch (err) {
    next(err);
  }
}

router.post("/auth/login", stockerAuthCtrl.login);
router.get("/auth/invite/:token", stockerAuthCtrl.validateInvite);
router.post("/auth/invite/:token/send-code", stockerAuthCtrl.sendVerificationCode);
router.post("/auth/invite/:token/verify", stockerAuthCtrl.verifyAndActivate);

router.use(stockerAuth);

router.get("/auth/me", stockerAuthCtrl.me);
router.get("/profile", stockerPanelCtrl.getProfile);
router.get("/products", stockerPanelCtrl.getProducts);
router.get("/requests", stockerPanelCtrl.getMyRequests);
router.post("/requests", stockerPanelCtrl.submitRequest);
router.get("/stats", stockerPanelCtrl.getMyStats);
router.get("/sold-deliveries", stockerPanelCtrl.getSoldDeliveries);
router.get("/payouts", stockerPanelCtrl.getMyPayouts);

module.exports = router;
