// Dev proxy to work around CORS for development only
// Usage: node dev-proxy.js
// This proxy will fetch requests to /proxy/* and forward them to https://files.rcsb.org/*

const express = require('express');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 8080;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/proxy/*', async (req, res) => {
  const path = req.params[0] || '';
  const target = `https://files.rcsb.org/${path}`;
  try {
    const resp = await fetch(target);
    if (!resp.ok) {
      res.status(resp.status).send(await resp.text());
      return;
    }
    // stream the body
    resp.body.pipe(res);
  } catch (err) {
    console.error('Proxy error fetching', target, err);
    res.status(502).send('Bad Gateway');
  }
});

app.listen(PORT, () => {
  console.log(`Dev proxy listening on http://localhost:${PORT}/proxy/...`);
});
