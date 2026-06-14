const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  appInfo: {
    name: "RBstars",
    version: "1.0.0",
  },
});

module.exports = stripe;
