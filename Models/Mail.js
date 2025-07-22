// models/Mail.js
const mongoose = require('mongoose');

const MailSchema = new mongoose.Schema({
  uid: Number,
  from: String,
  to: String,
  subject: String,
  text: String,
  folder: String,
  date: String,
  starred: { type: Boolean, default: false }, // <-- ADD THIS LINE
});

module.exports = mongoose.model('Mail', MailSchema);
