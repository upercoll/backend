const router = require("express").Router();
const {
  register,
  login,
  verifyEmail,
  resendVerification,
  me,
  updateProfile,
} = require("../controllers/customerAuthController");
const { protectCustomer } = require("../middleware/customerAuth");

router.post("/register", register);
router.post("/login", login);
router.get("/me", protectCustomer, me);
router.post("/verify-email", protectCustomer, verifyEmail);
router.post("/resend-verification", protectCustomer, resendVerification);
router.patch("/profile", protectCustomer, updateProfile);

module.exports = router;
