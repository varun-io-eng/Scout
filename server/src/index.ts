import './load-env.js';
import express from 'express';
import cors from 'cors';
import routes from './routes.js';
import { getProvider, hasAI } from './ai.js';
import { metrics } from './metrics.js';

const app = express();
const port = Number(process.env.PORT) || 3847;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api', routes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ai: hasAI() ? getProvider() : 'not configured',
  });
});

// Readiness check endpoint
app.get('/ready', (req, res) => {
  const isReady = hasAI();
  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks: {
      ai_configured: hasAI(),
    },
  });
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  res.json(metrics.getAllMetrics());
});

app.listen(port, () => {
  const mode = hasAI() ? getProvider() : 'fallback (set GROQ_API_KEY in server/.env)';
  console.log(`Scout API running at http://localhost:${port}`);
  console.log(`AI mode: ${mode}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`Metrics: http://localhost:${port}/metrics`);
});
