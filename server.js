require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const apiKeyAuth = require('./src/middleware/apiKey');
const bookingsRouter = require('./src/routes/bookings');
const customersRouter = require('./src/routes/customers');
const racecontrolRouter = require('./src/routes/racecontrol');
const ollamaRouter = require('./src/routes/ollama');
const calendarRouter = require('./src/routes/calendar');
const waiversRouter = require('./src/routes/waivers');
const logger = require('./src/utils/logger');

const app = express();
const PORT = process.env.PORT || 3100;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger }));

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'racingpoint-api-gateway', timestamp: new Date().toISOString() });
});

// Protected routes
app.use('/api/bookings', apiKeyAuth, bookingsRouter);
app.use('/api/customers', apiKeyAuth, customersRouter);
app.use('/api/racecontrol', apiKeyAuth, racecontrolRouter);
app.use('/api/ollama', apiKeyAuth, ollamaRouter);
app.use('/api/calendar', apiKeyAuth, calendarRouter);
app.use('/api/waivers', apiKeyAuth, waiversRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'RacingPoint API Gateway started');
});
