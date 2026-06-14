const logger = require("../utils/logger");
const AppError = require("../utils/AppError");

function handleCastError(err) {
  return new AppError(`Invalid ${err.path}: ${err.value}`, 400);
}

function handleDuplicateKey(err) {
  const field = Object.keys(err.keyValue)[0];
  return new AppError(`A record with that ${field} already exists`, 400);
}

function handleValidationError(err) {
  const messages = Object.values(err.errors).map((e) => e.message);
  return new AppError(messages.join(". "), 400);
}

function handleJWTError() {
  return new AppError("Invalid token — please log in again", 401);
}

function handleJWTExpired() {
  return new AppError("Token expired — please log in again", 401);
}

module.exports = function errorHandler(err, req, res, next) {
  let error = err;

  if (err.name === "CastError") error = handleCastError(err);
  else if (err.code === 11000) error = handleDuplicateKey(err);
  else if (err.name === "ValidationError") error = handleValidationError(err);
  else if (err.name === "JsonWebTokenError") error = handleJWTError();
  else if (err.name === "TokenExpiredError") error = handleJWTExpired();

  const statusCode = error.statusCode || 500;
  const message = error.isOperational ? error.message : "Something went wrong";

  if (statusCode >= 500) {
    logger.error({
      message: err.message,
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
    });
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && {
      stack: err.stack,
      detail: err.message,
    }),
  });
};
