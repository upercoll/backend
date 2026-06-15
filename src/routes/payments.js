const router = require("express").Router();
const ctrl = require("../controllers/paymentController");
const { paymentLimiter } = require("../middleware/rateLimiter");

router.post("/webhook", ctrl.webhook);

router.post("/create-intent", paymentLimiter, ctrl.createPaymentIntent);
router.post("/confirm", paymentLimiter, ctrl.confirmPayment);

router.post("/paypal-intent", paymentLimiter, ctrl.createPaypalPaymentIntent);

module.exports = router;
