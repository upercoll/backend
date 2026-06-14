class APIFeatures {
  constructor(query, queryString) {
    this.query = query;
    this.queryString = queryString;
  }

  filter() {
    const excluded = ["page", "sort", "limit", "fields", "search"];
    const queryObj = Object.fromEntries(
      Object.entries(this.queryString).filter(([k]) => !excluded.includes(k))
    );

    let queryStr = JSON.stringify(queryObj);
    queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (m) => `$${m}`);
    this.query = this.query.find(JSON.parse(queryStr));
    return this;
  }

  search(fields = ["name"]) {
    if (this.queryString.search) {
      const regex = new RegExp(this.queryString.search, "i");
      this.query = this.query.find({ $or: fields.map((f) => ({ [f]: regex })) });
    }
    return this;
  }

  sort() {
    if (this.queryString.sort) {
      const sortBy = this.queryString.sort.split(",").join(" ");
      this.query = this.query.sort(sortBy);
    } else {
      this.query = this.query.sort("-createdAt");
    }
    return this;
  }

  limitFields() {
    if (this.queryString.fields) {
      const fields = this.queryString.fields.split(",").join(" ");
      this.query = this.query.select(fields);
    }
    return this;
  }

  paginate() {
    const page = Math.max(1, parseInt(this.queryString.page) || 1);
    const limit = Math.min(100, parseInt(this.queryString.limit) || 20);
    this.query = this.query.skip((page - 1) * limit).limit(limit);
    this._page = page;
    this._limit = limit;
    return this;
  }
}

module.exports = APIFeatures;
