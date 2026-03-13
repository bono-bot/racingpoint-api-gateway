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
const commsRouter = require('./src/routes/comms');
const transcribeRouter = require('./src/routes/transcribe');
const { router: paymentsRouter, webhookHandler } = require('./src/routes/payments');
const logger = require('./src/utils/logger');

const app = express();
const PORT = process.env.PORT || 3100;

// CRITICAL: Webhook route MUST be registered BEFORE express.json() to preserve raw body for HMAC verification
app.use(cors());
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// Middleware (after webhook route)
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
app.use('/api/comms', apiKeyAuth, commsRouter);
app.use('/api/transcribe', apiKeyAuth, transcribeRouter);
app.use('/api/payments', paymentsRouter);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'RacingPoint API Gateway started');
});
