const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
const emailuser = require('./Routes/emailUser');

const app = express();

app.use(express.json());


app.use('/api/email', emailuser);

mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://finaxisai:YuRle5xEThDYf8sV@cluster0.dagsoxh.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected successfully!');
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});


app.get('/', (req, res) => {
  res.send('API Running! -> CI/CD testing !!!!!!!');
});

const PORT = process.env.PORT || 5879;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
