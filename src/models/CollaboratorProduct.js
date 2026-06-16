const mongoose = require("mongoose");

const collaboratorProductSchema = new mongoose.Schema(
  {
    collaborator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collaborator",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: { type: String },
    productSlug: { type: String },
    cut: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

collaboratorProductSchema.index({ collaborator: 1, product: 1 }, { unique: true });

module.exports = mongoose.model("CollaboratorProduct", collaboratorProductSchema);
