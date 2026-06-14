const jwt = require("jsonwebtoken");
const User = require("../models/User");
const AppError = require("../utils/AppError");

async function protect(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new AppError("Not authenticated — please log in", 401));
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("+active");
    if (!user || !user.active) {
      return next(new AppError("User no longer exists or is inactive", 401));
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError") return next(new AppError("Invalid token", 401));
    if (err.name === "TokenExpiredError") return next(new AppError("Token expired — please log in again", 401));
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return next(new AppError("You do not have permission to perform this action", 403));
    }
    next();
  };
}

const adminOnly = requireRole("admin");
const supportOrAdmin = requireRole("admin", "support");

module.exports = { protect, requireRole, adminOnly, supportOrAdmin };
