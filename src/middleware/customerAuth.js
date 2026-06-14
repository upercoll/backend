const jwt = require("jsonwebtoken");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");

async function protectCustomer(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new AppError("Not authenticated — please log in", 401));
    }

    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== "customer") {
      return next(new AppError("Invalid token type", 401));
    }

    const customer = await Customer.findById(decoded.id).select("+active");
    if (!customer || !customer.active) {
      return next(new AppError("Account no longer exists or is inactive", 401));
    }

    req.customer = customer;
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError") return next(new AppError("Invalid token", 401));
    if (err.name === "TokenExpiredError") return next(new AppError("Session expired — please log in again", 401));
    next(err);
  }
}

module.exports = { protectCustomer };
