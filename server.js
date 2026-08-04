/**
 * server.js — HTTPS static file server for Photon.
 *
 * Serves the public/ directory over HTTPS so that getUserMedia works
 * on mobile browsers accessed via LAN IP.
 *
 * Usage: npm start        (default port 3000)
 *        PORT=8443 npm start
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types for static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function handler(req, res) {
  // Map URL to file path
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try adding .html extension
      if (!path.extname(filePath)) {
        fs.readFile(filePath + '.html', (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data2);
          }
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// --- Get LAN IPs ---
function getLanIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(interfaces)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) {
        ips.push(cfg.address);
      }
    }
  }
  return ips;
}

// --- Start server ---
const keyPath = path.join(__dirname, 'cert', 'key.pem');
const certPath = path.join(__dirname, 'cert', 'cert.pem');

let server;
let protocol;

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  server = https.createServer(options, handler);
  protocol = 'https';
} else {
  console.warn(
    '⚠  No cert found in cert/. Starting plain HTTP server.\n' +
    '   Phone camera access (getUserMedia) will NOT work over plain HTTP.\n' +
    '   Run: npm run generate-cert\n'
  );
  server = http.createServer(handler);
  protocol = 'http';
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIPs = getLanIPs();
  console.log('\n  ┌─────────────────────────────────────────────┐');
  console.log('  │           P H O T O N  server                │');
  console.log('  ├─────────────────────────────────────────────┤');
  console.log(`  │  Local:   ${protocol}://localhost:${PORT}            │`);
  for (const ip of lanIPs) {
    const url = `${protocol}://${ip}:${PORT}`;
    console.log(`  │  LAN:     ${url.padEnd(33)}│`);
  }
  console.log('  ├─────────────────────────────────────────────┤');
  console.log(`  │  Sender:  ${protocol}://<IP>:${PORT}/sender.html   │`);
  console.log(`  │  Receiver:${protocol}://<IP>:${PORT}/receiver.html │`);
  console.log('  └─────────────────────────────────────────────┘\n');

  if (protocol === 'https') {
    console.log('  Phone: accept the certificate warning once,');
    console.log('  then camera access will work.\n');
  }
});
