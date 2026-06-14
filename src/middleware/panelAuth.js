const jwt = require("jsonwebtoken");
const User = require("../models/User");
const TeamMember = require("../models/TeamMember");
const Role = require("../models/Role");
const AppError = require("../utils/AppError");

async function panelAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new AppError("Not authenticated", 401));
    }

    const token = header.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") return next(new AppError("Session expired", 401));
      return next(new AppError("Invalid token", 401));
    }

    if (decoded.type === "owner") {
      const user = await User.findById(decoded.id).select("+active");
      if (!user || !user.active || user.role !== "admin") {
        return next(new AppError("Access denied", 403));
      }
      req.panelUser = {
        id: user._id.toString(),
        email: user.email,
        type: "owner",
        isOwner: true,
        permissions: getAllPermissions(),
        user,
      };
      return next();
    }

    if (decoded.type === "team_member") {
      const member = await TeamMember.findById(decoded.id).populate({
        path: "role",
        select: "permissions name color active",
      });
      if (!member || !member.active || member.status !== "active") {
        return next(new AppError("Account inactive or not found", 401));
      }
      if (!member.role || !member.role.active) {
        return next(new AppError("Your role has been deactivated", 403));
      }
      req.panelUser = {
        id: member._id.toString(),
        email: member.email,
        type: "team_member",
        isOwner: false,
        permissions: member.role.permissions || [],
        role: member.role,
        claimGames: member.claimGames || [],
        member,
      };
      return next();
    }

    return next(new AppError("Invalid token type", 401));
  } catch (err) {
    next(err);
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.panelUser) return next(new AppError("Not authenticated", 401));
    if (req.panelUser.isOwner) return next();
    if (!req.panelUser.permissions.includes(permission)) {
      return next(new AppError(`Missing permission: ${permission}`, 403));
    }
    next();
  };
}

function ownerOnly(req, res, next) {
  if (!req.panelUser?.isOwner) {
    return next(new AppError("Owner access required", 403));
  }
  next();
}

function signPanelToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.PANEL_JWT_EXPIRES_IN || "12h",
  });
}

function getAllPermissions() {
  const { PERMISSIONS } = require("../models/Role");
  return PERMISSIONS;
}

module.exports = { panelAuth, requirePermission, ownerOnly, signPanelToken };
