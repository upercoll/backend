const Product = require("../models/Product");
const StockRequest = require("../models/StockRequest");
const StockSale = require("../models/StockSale");
const Stocker = require("../models/Stocker");

const finiteQuantity = (value) => Number.isInteger(value) && value > 0;

async function addStock(productId, quantity) {
  if (!finiteQuantity(quantity)) throw new Error("Stock quantity must be a positive whole number");

  return Product.findByIdAndUpdate(
    productId,
    [
      {
        $set: {
          // -1 means “unlimited” for storefront products. Stocking a real batch must
          // start at zero, not add to the sentinel (-1 + 2 previously became 1).
          stock: { $add: [{ $cond: [{ $lt: ["$stock", 0] }, 0, "$stock"] }, quantity] },
          onHand: { $add: [{ $cond: [{ $lt: ["$onHand", 0] }, 0, "$onHand"] }, quantity] },
          outOfStock: false,
        },
      },
    ],
    { new: true }
  );
}

async function removeStock(productId, quantity) {
  if (!finiteQuantity(quantity)) throw new Error("Sale quantity must be a positive whole number");

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      $and: [
        { $or: [{ stock: -1 }, { stock: { $gte: quantity } }] },
        { $or: [{ onHand: -1 }, { onHand: { $gte: quantity } }] },
      ],
    },
    [
      {
        $set: {
          stock: { $cond: [{ $lt: ["$stock", 0] }, -1, { $subtract: ["$stock", quantity] }] },
          onHand: { $cond: [{ $lt: ["$onHand", 0] }, -1, { $subtract: ["$onHand", quantity] }] },
          salesCount: { $add: [{ $ifNull: ["$salesCount", 0] }, quantity] },
        },
      },
    ],
    { new: true }
  );

  if (product && product.stock === 0) {
    await Product.updateOne({ _id: product._id }, { $set: { outOfStock: true } });
  }
  return product;
}

async function removeStockForDeletedRequest(productId, quantity) {
  if (!finiteQuantity(quantity)) throw new Error("Stock quantity must be a positive whole number");

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      $and: [
        { $or: [{ stock: -1 }, { stock: { $gte: quantity } }] },
        { $or: [{ onHand: -1 }, { onHand: { $gte: quantity } }] },
      ],
    },
    [
      {
        $set: {
          stock: { $cond: [{ $lt: ["$stock", 0] }, -1, { $subtract: ["$stock", quantity] }] },
          onHand: { $cond: [{ $lt: ["$onHand", 0] }, -1, { $subtract: ["$onHand", quantity] }] },
        },
      },
    ],
    { new: true }
  );
  if (product && product.stock === 0) {
    await Product.updateOne({ _id: product._id }, { $set: { outOfStock: true } });
  }
  return product;
}

async function allocateStockedBatches(order) {
  const sales = [];

  for (const item of order.items || []) {
    let remaining = item.quantity;
    const allocations = [];
    const requests = await StockRequest.find({
      status: "stocked",
      items: { $elemMatch: { product: item.product, remainingQuantity: { $gt: 0 } } },
    }).sort({ stockedAt: 1, createdAt: 1 });

    for (const request of requests) {
      if (remaining <= 0) break;
      const requestItem = request.items.find(
        (candidate) => String(candidate.product) === String(item.product) && (candidate.remainingQuantity || 0) > 0
      );
      if (!requestItem) continue;

      const allocatedQuantity = Math.min(remaining, requestItem.remainingQuantity);
      const updated = await StockRequest.findOneAndUpdate(
        {
          _id: request._id,
          items: {
            $elemMatch: {
              product: item.product,
              remainingQuantity: { $gte: allocatedQuantity },
            },
          },
        },
        {
          $inc: {
            "items.$.remainingQuantity": -allocatedQuantity,
            "items.$.soldQuantity": allocatedQuantity,
          },
        },
        { new: true }
      );
      if (!updated) continue;

      allocations.push({
        request: request._id,
        stocker: request.stocker,
        quantity: allocatedQuantity,
        unitRevenue: Number(requestItem.storePrice ?? requestItem.salePrice ?? 0),
        commissionRate: Number(request.commissionRate || 0),
      });
      remaining -= allocatedQuantity;
    }

    if (allocations.length) {
      sales.push({
        order: order._id,
        orderNumber: order.orderNumber,
        product: item.product,
        productName: item.productSnapshot?.name || "Item",
        quantity: item.quantity - remaining,
        customer: {
          robloxUsername: order.customer?.robloxUsername || "",
          email: order.customer?.email || "",
        },
        allocations,
      });
    }
  }

  if (sales.length) await StockSale.insertMany(sales);
  return sales;
}

async function rollbackStockedBatchAllocations(orderId) {
  const sales = await StockSale.find({ order: orderId });
  for (const sale of sales) {
    for (const allocation of sale.allocations || []) {
      await StockRequest.updateOne(
        { _id: allocation.request },
        {
          $inc: {
            "items.$[item].remainingQuantity": allocation.quantity,
            "items.$[item].soldQuantity": -allocation.quantity,
          },
        },
        { arrayFilters: [{ "item.product": sale.product }] }
      );
    }
  }
  await StockSale.deleteMany({ order: orderId });
}

async function markOrderDelivered(orderNumber, claimRoomId) {
  const sales = await StockSale.find({ orderNumber, deliveredAt: { $exists: false } });
  if (!sales.length) return [];

  const deliveredAt = new Date();
  for (const sale of sales) {
    const updated = await StockSale.findOneAndUpdate(
      { _id: sale._id, deliveredAt: { $exists: false } },
      { $set: { deliveredAt, claimRoomId } },
      { new: true }
    );
    if (!updated) continue;

    for (const allocation of updated.allocations) {
      const revenue = allocation.unitRevenue * allocation.quantity;
      const commission = revenue * (allocation.commissionRate / 100);
      await Stocker.updateOne(
        { _id: allocation.stocker },
        { $inc: { totalRevenue: revenue, totalCommission: commission } }
      );
    }
  }
  return sales;
}

module.exports = {
  addStock,
  removeStock,
  removeStockForDeletedRequest,
  allocateStockedBatches,
  rollbackStockedBatchAllocations,
  markOrderDelivered,
};
