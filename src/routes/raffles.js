const express = require("express");
const router = express.Router();
const { protectCustomer } = require("../middleware/customerAuth");
const ctrl = require("../controllers/raffleController");

// Public — the storefront raffle page. /current reads the customer token
// when present (optional auth) so signed-out visitors see the same page.
router.get("/current", ctrl.getCurrent);
router.get("/me", protectCustomer, ctrl.getMe);
router.post("/:id/claim", protectCustomer, ctrl.claim);

module.exports = router;
