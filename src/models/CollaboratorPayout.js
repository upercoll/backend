const mongoose = require("mongoose");

const saleItemSchema = new mongoose.Schema(
  {
    orderId: { type: String },
    orderNumber: { type: String },
    orderDate: { type: Date },
    productId: { type: String },
    productName: { type: String },
    sku: { type: String },
    unitPrice: { type: Number },
    quantity: { type: Number },
    orderTotal: { type: Number },
    cut: { type: Number },
    earnings: { type: Number },
  },
  { _id: false }
);

const collaboratorPayoutSchema = new mongoose.Schema(
  {
    collaborator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collaborator",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "paid"],
      default: "paid",
    },
    amount: { type: Number, required: true },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    paidAt: { type: Date },
    paidBy: { type: String },
    sales: [saleItemSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("CollaboratorPayout", collaboratorPayoutSchema);
