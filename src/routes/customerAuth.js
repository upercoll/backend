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

router.get("/roblox-avatar", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ avatarUrl: null });
  try {
    const usersRes = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const usersData = await usersRes.json();
    const userId = usersData?.data?.[0]?.id;
    if (!userId) return res.json({ avatarUrl: null });
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );
    const thumbData = await thumbRes.json();
    const avatarUrl = thumbData?.data?.[0]?.imageUrl || null;
    return res.json({ avatarUrl });
  } catch {
    return res.json({ avatarUrl: null });
  }
});

module.exports = router;
