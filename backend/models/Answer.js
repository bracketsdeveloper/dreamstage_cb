'use strict'

const mongoose = require("mongoose")
const { Schema } = mongoose

const responseSchema = new Schema({
  question:  { type: Schema.Types.ObjectId, ref: "Question", required: true },
  answer:    { type: Schema.Types.Mixed,    required: true },
  confirmed: { type: Boolean,               default: false }
}, { _id: false })

const answerSchema = new Schema({
  phoneNumber: { type: String, required: true, unique: true },
  userName:    { type: String, default: "" },
  responses:   { type: [responseSchema],     default: [] }
}, { timestamps: true })

module.exports = mongoose.model("Answer", answerSchema)
