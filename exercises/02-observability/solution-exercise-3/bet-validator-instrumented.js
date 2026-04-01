// bet-validator.js — with manual instrumentation added
// Load with: node --require ./instrumentation.js bet-validator.js

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Get a tracer for this service's business logic spans
const tracer = trace.getTracer('bet-validator');

app.post('/validate', async (req, res) => {
  const { betId, playerId, selections } = req.body;

  // Manual span for the business logic layer
  // Note: the HTTP layer span (POST /validate) is created automatically by auto-instrumentation
  return tracer.startActiveSpan('bet.validate_odds', async (span) => {
    try {
      // Add safe attributes — IDs and counts, never values or PII
      span.setAttributes({
        'bet.id': betId,
        'bet.selection_count': selections?.length ?? 0,
        // NOT: 'player.id': playerId — depends on your GDPR stance
        // NOT: 'bet.selections': JSON.stringify(selections) — may contain match details linked to a player
      });

      const client = await pool.connect();
      try {
        // pg auto-instrumentation creates a child span for this query automatically
        const result = await client.query(
          'SELECT match_id, odds FROM current_odds WHERE match_id = ANY($1)',
          [selections.map(s => s.matchId)]
        );

        const oddsMap = {};
        result.rows.forEach(row => {
          oddsMap[row.match_id] = parseFloat(row.odds);
        });

        const valid = selections.every(s =>
          Math.abs(oddsMap[s.matchId] - s.expectedOdds) < 0.001
        );

        if (!valid) {
          // Record validation failure — use span event, not error status
          // (this is a business outcome, not a system error)
          span.addEvent('bet.validation.failed', {
            reason: 'odds_changed',
          });
          span.setAttributes({ 'bet.valid': false, 'bet.rejection_reason': 'odds_changed' });
        } else {
          span.setAttributes({ 'bet.valid': true });
        }

        span.end();
        return res.json({ valid, betId });

      } finally {
        client.release();
      }

    } catch (err) {
      // System error (DB connection failed, unexpected exception)
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// Health check — auto-instrumentation is configured to ignore this endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(3000, () => {
  console.log('bet-validator listening on port 3000');
});
