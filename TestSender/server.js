const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// ---------- Utility: Get local IPv4 address ----------
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip loopback & IPv6 — accept any private IPv4
            if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.0')) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// ---------- Serve static UI ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API Endpoints ----------

// GET /ping
app.get('/ping', (_req, res) => {
    res.json({ status: 'ok' });
});

// GET /files — list uploaded files with name & size
app.get('/files', (_req, res) => {
    try {
        const files = fs.readdirSync(UPLOADS_DIR).map((name) => {
            const stats = fs.statSync(path.join(UPLOADS_DIR, name));
            return { name, size: stats.size };
        });
        res.json(files);
    } catch (err) {
        res.json([]);
    }
});

// GET /download?name=filename — stream file back
app.get('/download', (req, res) => {
    const rawName = req.query.name;
    if (!rawName) return res.status(400).json({ error: 'Missing "name" query parameter' });

    // Decode URL-encoded filename (spaces, special chars)
    const decodedName = decodeURIComponent(rawName);
    console.log(`[download] raw='${rawName}' decoded='${decodedName}'`);

    const filePath = path.join(UPLOADS_DIR, decodedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${decodedName}` });

    res.download(filePath);
});

// POST /upload — accept file via multer
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ success: true, name: req.file.originalname, size: req.file.size });
});

// DELETE /delete?name=filename — remove a file
app.delete('/delete', (req, res) => {
    const rawName = req.query.name;
    if (!rawName) return res.status(400).json({ error: 'Missing "name" query parameter' });

    // Decode URL-encoded filename
    const decodedName = decodeURIComponent(rawName);
    const filePath = path.join(UPLOADS_DIR, decodedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${decodedName}` });

    fs.unlinkSync(filePath);
    res.json({ success: true });
});

// GET /qr — generate QR code data-URL
app.get('/qr', async (_req, res) => {
    const ip = getLocalIP();
    const payload = {
        ssid: '',
        password: '',
        ip,
        port: PORT,
        filesEndpoint: '/files',
        downloadEndpoint: '/download',
        deviceName: 'TestSender',
    };
    console.log('[QR] Payload:', JSON.stringify(payload));

    try {
        const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
            width: 300,
            margin: 2,
            color: { dark: '#ffffff', light: '#00000000' },
        });
        res.json({ qr: dataUrl, payload });
    } catch (err) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

// ---------- Start server ----------
app.listen(PORT, HOST, () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  ╔═══════════════════════════════════════════╗');
    console.log('  ║       🚀  TestSender is running!          ║');
    console.log('  ╠═══════════════════════════════════════════╣');
    console.log(`  ║  Local:   http://localhost:${PORT}            ║`);
    console.log(`  ║  Network: http://${ip}:${PORT}     ║`);
    console.log('  ╚═══════════════════════════════════════════╝');
    console.log('');
});
