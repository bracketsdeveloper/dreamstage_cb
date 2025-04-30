// backend/models/Question.js
const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    answerType: {
      type: String,
      enum: ["text", "number", "boolean", "options"],
      required: true,
    },
    options: { type: [String], default: [] },
    numberDigits: { type: Number, default: null },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Question", questionSchema);
