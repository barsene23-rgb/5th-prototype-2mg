console.log("🔥 SERVER FILE LOADED FROM:", __dirname);
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const multer = require('multer');
const path = require("path");
const { createClient } = require("@libsql/client");
const cloudinary = require("cloudinary").v2;

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ======================
// CONSTANTS
// ======================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(32).toString("hex");
const VALID_ADMIN_TOKENS = new Set([ADMIN_TOKEN]);

// Kill switch secret — deliberately SEPARATE from ADMIN_TOKEN. If a device with the
// admin app installed is ever lost/stolen, the ADMIN_TOKEN may already be cached on
// that device — so it can't be trusted to lock things down. This secret should live
// only in your head / password manager, never on the device itself. Set it as a fixed
// env var (KILL_SWITCH_SECRET) on Render — same lesson learned from the ADMIN_TOKEN
// regenerating on restart bug.
const KILL_SWITCH_SECRET = process.env.KILL_SWITCH_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.KILL_SWITCH_SECRET) {
    console.warn("⚠️  KILL_SWITCH_SECRET is not set — a random one was generated for this run and will change on restart. Set it as a fixed environment variable on Render.");
}

const PORT = process.env.PORT || 3000; // Render assigns its own PORT — this now respects that
const MOMO_BASE_URL = "https://sandbox.momodeveloper.mtn.com";
const CURRENCY = "EUR"; // ← Change to "RWF" when going live with real keys

// ======================
// PRODUCT CATEGORY STRUCTURE — single source of truth, shared with admin.html and index.html via GET /categories
// ======================
const CATEGORY_STRUCTURE = {
    "accessories": {
        label: "Accessories",
        emoji: "🧤",
        subcategories: { "socks": "Socks", "gloves": "Gloves", "goggles": "Goggles" }
    },
    "basketball-shoes": {
        label: "Basketball Shoes",
        emoji: "🏀",
        subcategories: {}
    },
    "football-shoes": {
        label: "Football Shoes",
        emoji: "⚽",
        subcategories: {}
    },
    "gym-clothes": {
        label: "Gym Clothes",
        emoji: "💪",
        subcategories: { "t-shirts": "T-Shirts", "shorts": "Shorts" }
    },
    "jerseys-kits": {
        label: "Jerseys & Team Kits",
        emoji: "🎽",
        subcategories: { "home-jersey": "Home Jersey", "away-jersey": "Away Jersey", "training-kit": "Training Kit" }
    },
    "fitness-equipment": {
        label: "Fitness Equipment",
        emoji: "🏋️",
        subcategories: { "weights": "Weights", "resistance-bands": "Resistance Bands", "yoga-mats": "Yoga Mats" }
    },
    "racket-sports": {
        label: "Racket Sports",
        emoji: "🎾",
        subcategories: { "tennis": "Tennis", "badminton": "Badminton", "table-tennis": "Table Tennis" }
    },
    "swimwear": {
        label: "Swimwear",
        emoji: "🏊",
        subcategories: {}
    },
    "cycling-gear": {
        label: "Cycling Gear",
        emoji: "🚴",
        subcategories: {}
    },
    "team-equipment": {
        label: "Team Equipment & Balls",
        emoji: "🏐",
        subcategories: { "basketballs": "Basketballs", "footballs": "Footballs", "volleyballs": "Volleyballs", "nets": "Nets & Goals" }
    }
};

function isValidCategory(cat) {
    return Object.prototype.hasOwnProperty.call(CATEGORY_STRUCTURE, cat);
}
function requiresSubcategory(cat) {
    const def = CATEGORY_STRUCTURE[cat];
    return !!(def && Object.keys(def.subcategories).length > 0);
}
function isValidSubcategory(cat, subcat) {
    const def = CATEGORY_STRUCTURE[cat];
    if (!def) return false;
    if (Object.keys(def.subcategories).length === 0) return true;
    return Object.prototype.hasOwnProperty.call(def.subcategories, subcat);
}

// ======================
// ENV VARIABLE CHECK ON STARTUP
// ======================
const REQUIRED_ENV = [
    "API_USER", "API_KEY", "SUBSCRIPTION_KEY",
    "TURSO_URL", "TURSO_TOKEN",
    "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"
];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error("❌ Missing required environment variables:", missingEnv.join(", "));
    console.error("   .env file being read from:", path.join(__dirname, ".env"));
    console.error("   Currently loaded env keys:", REQUIRED_ENV.filter(key => !!process.env[key]).join(", ") || "(none)");
    console.error("   Please check your .env file (or Render environment settings) and restart the server.");
    process.exit(1);
}

// ======================
// DATABASE SETUP — Turso (cloud SQLite, always online, survives restarts)
// ======================
const db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN
});

// ======================
// IMAGE STORAGE SETUP — Cloudinary (cloud photo storage, survives restarts)
// ======================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Files are held in memory only just long enough to forward them to Cloudinary — nothing touches local disk
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

function uploadToCloudinary(fileBuffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: '2mg-sports-park' },
            (error, result) => {
                if (error) return reject(error);
                resolve(result.secure_url);
            }
        );
        stream.end(fileBuffer);
    });
}

async function setupDatabase() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            whatsapp_number TEXT NOT NULL,
            momo_number TEXT NOT NULL,
            items TEXT NOT NULL,
            total_amount TEXT NOT NULL,
            reference_id TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'PENDING',
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            total_raw REAL DEFAULT 0,
            order_type TEXT DEFAULT 'MOMO',
            payment_method TEXT DEFAULT 'MOMO',
            branch TEXT DEFAULT '',
            delivery_type TEXT DEFAULT 'Pickup',
            delivery_address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            member_id TEXT DEFAULT ''
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS admin (
            id INTEGER PRIMARY KEY,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS products (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            shop        TEXT NOT NULL DEFAULT 'shop1',
            name        TEXT NOT NULL,
            brand       TEXT NOT NULL DEFAULT '',
            category    TEXT NOT NULL DEFAULT 'General',
            subcategory TEXT DEFAULT '',
            price       REAL NOT NULL DEFAULT 0,
            price_label TEXT NOT NULL DEFAULT '',
            image_url   TEXT DEFAULT '',
            badge       TEXT DEFAULT '',
            in_stock    INTEGER DEFAULT 1,
            created_at  TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    // Safety net for databases created before subcategory existed — safe to ignore if the column is already there
    try {
        await db.execute(`ALTER TABLE products ADD COLUMN subcategory TEXT DEFAULT ''`);
        console.log("✅ Added subcategory column to products table");
    } catch (err) {
        if (!/duplicate column/i.test(err.message)) {
            throw err;
        }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS product_images (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id  INTEGER NOT NULL,
            image_url   TEXT NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id       TEXT UNIQUE NOT NULL,
            full_name       TEXT NOT NULL,
            whatsapp_number TEXT NOT NULL,
            email           TEXT UNIQUE NOT NULL,
            password_hash   TEXT NOT NULL,
            created_at      TEXT DEFAULT (datetime('now', 'localtime')),
            last_login      TEXT DEFAULT ''
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS customer_sessions (
            token      TEXT PRIMARY KEY,
            member_id  TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    // Customer product requests — used when someone clicks a category/photo we don't currently stock
    await db.execute(`
        CREATE TABLE IF NOT EXISTS product_requests (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            item_name         TEXT NOT NULL,
            description       TEXT DEFAULT '',
            customer_name     TEXT NOT NULL,
            contact_whatsapp  TEXT NOT NULL,
            contact_email     TEXT DEFAULT '',
            branch            TEXT DEFAULT '',
            status            TEXT DEFAULT 'NEW',
            created_at        TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);

    // Kill switch — a single-row table holding whether the admin app is remotely disabled.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS app_control (
            id                    INTEGER PRIMARY KEY CHECK (id = 1),
            kill_switch_enabled   INTEGER DEFAULT 0,
            updated_at            TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);
    await db.execute(`INSERT OR IGNORE INTO app_control (id, kill_switch_enabled) VALUES (1, 0)`);
}

async function isKillSwitchEnabled() {
    const result = await db.execute(`SELECT kill_switch_enabled FROM app_control WHERE id = 1`);
    return !!(result.rows[0]?.kill_switch_enabled);
}

function hashPassword(password, salt = null) {
    const realSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, realSalt, 64).toString('hex');
    return { salt: realSalt, hash };
}

function verifyPassword(password, salt, hash) {
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

async function generateMemberId() {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    let id;
    let exists = true;
    do {
        id = `2MG-${segment()}-${segment()}`;
        const result = await db.execute({ sql: `SELECT id FROM users WHERE member_id = ?`, args: [id] });
        exists = result.rows.length > 0;
    } while (exists);
    return id;
}

async function verifyCustomer(req, res, next) {
    try {
        const token = req.headers['x-customer-token'];
        if (!token) {
            return res.status(401).json({ success: false, error: "Login required" });
        }
        const sessionResult = await db.execute({ sql: `SELECT member_id FROM customer_sessions WHERE token = ?`, args: [token] });
        const session = sessionResult.rows[0];
        if (!session) {
            return res.status(401).json({ success: false, error: "Session expired, please log in again" });
        }
        const userResult = await db.execute({ sql: `SELECT id, member_id, full_name, whatsapp_number, email FROM users WHERE member_id = ?`, args: [session.member_id] });
        const user = userResult.rows[0];
        if (!user) {
            return res.status(401).json({ success: false, error: "Account not found" });
        }
        req.customer = user;
        next();
    } catch (err) {
        console.error("❌ VERIFY CUSTOMER ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
}

async function seedAdminPassword() {
    const result = await db.execute(`SELECT id FROM admin WHERE id = 1`);
    if (result.rows.length === 0) {
        const { salt, hash } = hashPassword(ADMIN_PASSWORD);
        await db.execute({ sql: `INSERT INTO admin (id, password_hash, salt) VALUES (1, ?, ?)`, args: [hash, salt] });
        console.log('✅ Admin password seeded from environment into the database');
    }
}

// ======================
// HELPERS
// ======================
function generateReferenceId() {
    return crypto.randomUUID();
}

function validatePhone(phone) {
    if (!phone || typeof phone !== "string" || phone.trim() === "") return false;
    const digits = phone.replace(/\D/g, "");
    return digits.length >= 9;
}

function validateAmount(amount) {
    const num = Number(amount);
    return !isNaN(num) && num > 0;
}

// ======================
// GET TOKEN FUNCTION
// ======================
async function getToken() {
    try {
        const response = await axios.post(
            `${MOMO_BASE_URL}/collection/token/`,
            {},
            {
                auth: {
                    username: process.env.API_USER,
                    password: process.env.API_KEY,
                },
                headers: {
                    "Ocp-Apim-Subscription-Key": process.env.SUBSCRIPTION_KEY
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        const msg = error.response?.data?.message || error.message || "Unknown error";
        throw new Error(`Failed to get access token: ${msg}`);
    }
}

async function verifyAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !VALID_ADMIN_TOKENS.has(token)) {
        return res.status(401).json({ success: false, error: "Unauthorized admin request" });
    }
    try {
        if (await isKillSwitchEnabled()) {
            return res.status(423).json({ success: false, error: "Admin access is currently disabled.", killSwitch: true });
        }
    } catch (err) {
        // If the kill-switch check itself fails (e.g. DB hiccup), log it but don't
        // silently lock out a legitimate admin over an unrelated glitch.
        console.error("⚠️ Kill switch check failed:", err.message);
    }
    return next();
}

function verifyKillSwitchSecret(req, res, next) {
    const key = req.headers['x-kill-switch-key'];
    if (key && key === KILL_SWITCH_SECRET) {
        return next();
    }
    return res.status(401).json({ success: false, error: "Invalid kill switch key" });
}

app.get("/kill-switch/status", async (req, res) => {
    try {
        const enabled = await isKillSwitchEnabled();
        return res.json({ enabled });
    } catch (err) {
        res.status(500).json({ enabled: false, error: err.message });
    }
});

app.post("/kill-switch/enable", verifyKillSwitchSecret, async (req, res) => {
    try {
        await db.execute(`UPDATE app_control SET kill_switch_enabled = 1, updated_at = datetime('now','localtime') WHERE id = 1`);
        return res.json({ success: true, enabled: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/kill-switch/disable", verifyKillSwitchSecret, async (req, res) => {
    try {
        await db.execute(`UPDATE app_control SET kill_switch_enabled = 0, updated_at = datetime('now','localtime') WHERE id = 1`);
        return res.json({ success: true, enabled: false });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/admin/login", async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ success: false, error: "Password is required." });
        }
        if (await isKillSwitchEnabled()) {
            return res.status(423).json({ success: false, error: "Admin access is currently disabled.", killSwitch: true });
        }

        const result = await db.execute(`SELECT password_hash, salt FROM admin WHERE id = 1`);
        const admin = result.rows[0];
        if (!admin) {
            return res.status(500).json({ success: false, error: "Admin credentials not initialized." });
        }

        if (!verifyPassword(password, admin.salt, admin.password_hash)) {
            return res.status(401).json({ success: false, error: "Invalid admin password." });
        }

        return res.json({ success: true, token: ADMIN_TOKEN });
    } catch (err) {
        console.error("❌ ADMIN LOGIN ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/admin/logout", verifyAdmin, (req, res) => {
    return res.json({ success: true, message: "Logged out successfully." });
});

app.get("/admin/stats", verifyAdmin, async (req, res) => {
    try {
        const totalOrders = (await db.execute(`SELECT COUNT(*) AS count FROM orders`)).rows[0].count;
        const successfulOrders = (await db.execute(`SELECT COUNT(*) AS count FROM orders WHERE status = 'SUCCESSFUL'`)).rows[0].count;
        const pendingOrders = (await db.execute(`SELECT COUNT(*) AS count FROM orders WHERE status = 'PENDING'`)).rows[0].count;
        const confirmedOrders = (await db.execute(`SELECT COUNT(*) AS count FROM orders WHERE status = 'CONFIRMED'`)).rows[0].count;
        const cancelledOrders = (await db.execute(`SELECT COUNT(*) AS count FROM orders WHERE status = 'CANCELLED'`)).rows[0].count;
        const failedOrders = (await db.execute(`SELECT COUNT(*) AS count FROM orders WHERE status = 'FAILED'`)).rows[0].count;
        const revenueRow = (await db.execute(`SELECT SUM(CAST(total_amount AS REAL)) AS total FROM orders WHERE status = 'SUCCESSFUL'`)).rows[0];
        const revenue = revenueRow.total || 0;
        const recentOrdersResult = await db.execute(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 5`);
        const recentOrders = recentOrdersResult.rows.map(order => ({
            ...order,
            items: JSON.parse(order.items || '[]')
        }));

        const totalUsers = (await db.execute(`SELECT COUNT(*) AS count FROM users`)).rows[0].count;
        const totalProducts = (await db.execute(`SELECT COUNT(*) AS count FROM products`)).rows[0].count;
        const newRequests = (await db.execute(`SELECT COUNT(*) AS count FROM product_requests WHERE status = 'NEW'`)).rows[0].count;

        return res.json({
            success: true,
            stats: {
                orders: { total: totalOrders, successful: successfulOrders, pending: pendingOrders, confirmed: confirmedOrders, cancelled: cancelledOrders, failed: failedOrders },
                users: totalUsers,
                revenue,
                products: { total: totalProducts },
                requests: { new: newRequests }
            },
            recentOrders
        });
    } catch (err) {
        console.error("❌ ADMIN STATS ERROR:", err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/admin/users", verifyAdmin, async (req, res) => {
    try {
        const search = (req.query.search || '').trim();
        let users;
        if (search) {
            const like = `%${search}%`;
            const result = await db.execute({
                sql: `SELECT * FROM users WHERE member_id LIKE ? OR full_name LIKE ? OR whatsapp_number LIKE ? OR email LIKE ? ORDER BY created_at DESC`,
                args: [like, like, like, like]
            });
            users = result.rows;
        } else {
            const result = await db.execute(`SELECT * FROM users ORDER BY created_at DESC`);
            users = result.rows;
        }

        const withCounts = [];
        for (const u of users) {
            const countResult = await db.execute({ sql: `SELECT COUNT(*) AS count FROM orders WHERE member_id = ?`, args: [u.member_id] });
            const spentResult = await db.execute({
                sql: `SELECT SUM(CAST(total_amount AS REAL)) AS total FROM orders WHERE member_id = ? AND status = 'SUCCESSFUL'`,
                args: [u.member_id]
            });
            withCounts.push({
                ...u,
                order_count: countResult.rows[0].count,
                total_spent: spentResult.rows[0].total || 0
            });
        }

        // Biggest spenders first, so top customers are always easy to spot
        withCounts.sort((a, b) => Number(b.total_spent) - Number(a.total_spent));

        res.json({ success: true, users: withCounts });
    } catch (err) {
        console.error("❌ FETCH USERS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ======================
// TEST TOKEN ROUTE
// ======================
app.get("/test-token", async (req, res) => {
    try {
        const token = await getToken();
        console.log("✅ TOKEN FETCHED SUCCESSFULLY");
        res.json({ success: true, token });
    } catch (error) {
        console.error("❌ Token error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ======================
// PAY ROUTE
// ======================
app.post("/pay", async (req, res) => {
    try {
        console.log("📲 PAY ROUTE HIT");

        const { phone, amount } = req.body;

        if (!validatePhone(phone)) {
            return res.status(400).json({
                success: false,
                error: "Invalid or missing phone number. Please provide a valid MSISDN."
            });
        }

        if (!validateAmount(amount)) {
            return res.status(400).json({
                success: false,
                error: "Invalid or missing amount. Must be a number greater than 0."
            });
        }

        const token = await getToken();
        console.log("✅ ACCESS TOKEN OBTAINED");

        const referenceId = generateReferenceId();

        await axios.post(
            `${MOMO_BASE_URL}/collection/v1_0/requesttopay`,
            {
                amount: String(amount),
                currency: CURRENCY,
                externalId: referenceId,
                payer: {
                    partyIdType: "MSISDN",
                    partyId: phone
                },
                payerMessage: "2MG Sports Park Payment",
                payeeNote: "Order Payment"
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Reference-Id": referenceId,
                    "X-Target-Environment": "sandbox",
                    "Ocp-Apim-Subscription-Key": process.env.SUBSCRIPTION_KEY,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("✅ PAYMENT REQUEST SENT — Ref:", referenceId);

        res.json({
            success: true,
            message: "Payment request sent successfully",
            referenceId
        });

    } catch (err) {
        const errDetail = err.response?.data || err.message;
        console.error("❌ PAY ERROR:", errDetail);
        res.status(500).json({ success: false, error: errDetail });
    }
});

// ======================
// STATUS ROUTE
// ======================
app.get("/status/:referenceId", async (req, res) => {
    try {
        const { referenceId } = req.params;

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(referenceId)) {
            return res.status(400).json({ success: false, error: "Invalid reference ID format." });
        }

        const token = await getToken();

        const response = await axios.get(
            `${MOMO_BASE_URL}/collection/v1_0/requesttopay/${referenceId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-Target-Environment": "sandbox",
                    "Ocp-Apim-Subscription-Key": process.env.SUBSCRIPTION_KEY
                }
            }
        );

        console.log("📊 STATUS CHECK — Ref:", referenceId, "| Status:", response.data.status);

        res.json({ success: true, ...response.data });

    } catch (err) {
        const errDetail = err.response?.data || err.message;
        console.error("❌ STATUS ERROR:", errDetail);
        res.status(500).json({ success: false, error: errDetail });
    }
});

// ======================
// SAVE ORDER ROUTE
// ======================
app.post("/save-order", async (req, res) => {
    try {
        const { customerName, whatsappNumber, momoNumber, items, totalAmount, referenceId, branch, deliveryType, deliveryAddress, notes, paymentMethod } = req.body;

        if (!customerName || !whatsappNumber || !momoNumber || !items || !totalAmount || !referenceId) {
            return res.status(400).json({ success: false, error: "Missing required order fields." });
        }

        // If the customer is logged in, link this order to their member account
        let memberId = '';
        const customerToken = req.headers['x-customer-token'];
        if (customerToken) {
            const sessionResult = await db.execute({ sql: `SELECT member_id FROM customer_sessions WHERE token = ?`, args: [customerToken] });
            const session = sessionResult.rows[0];
            if (session) memberId = session.member_id;
        }

        await db.execute({
            sql: `
                INSERT INTO orders (customer_name, whatsapp_number, momo_number, items, total_amount, reference_id, status, member_id, branch, delivery_type, delivery_address, notes, payment_method)
                VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
            `,
            args: [
                customerName,
                whatsappNumber,
                momoNumber,
                JSON.stringify(items),
                totalAmount,
                referenceId,
                memberId,
                branch || 'Not specified',
                deliveryType || 'Pickup',
                deliveryAddress || '',
                notes || '',
                paymentMethod || 'WhatsApp'
            ]
        });

        console.log("💾 ORDER SAVED — Ref:", referenceId, "| Customer:", customerName, "| Branch:", branch || 'Not specified');

        res.json({ success: true, message: "Order saved as PENDING" });

    } catch (err) {
        console.error("❌ SAVE ORDER ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ======================
// UPDATE ORDER STATUS ROUTE
// ======================
app.patch("/update-status/:referenceId", async (req, res) => {
    try {
        const { referenceId } = req.params;
        const { status } = req.body;

        const allowed = ["SUCCESSFUL", "FAILED", "PENDING", "CONFIRMED", "CANCELLED"];
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, error: "Invalid status value." });
        }

        const result = await db.execute({ sql: `UPDATE orders SET status = ? WHERE reference_id = ?`, args: [status, referenceId] });

        if (Number(result.rowsAffected) === 0) {
            return res.status(404).json({ success: false, error: "Order not found." });
        }

        console.log(`✅ ORDER UPDATED — Ref: ${referenceId} | Status: ${status}`);

        res.json({ success: true, message: `Order status updated to ${status}` });

    } catch (err) {
        console.error("❌ UPDATE STATUS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ======================
// SHAREABLE ORDER SUMMARY PAGE (with WhatsApp/social link preview)
// ======================
function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

app.get("/order/:referenceId", async (req, res) => {
    try {
        const { referenceId } = req.params;
        const result = await db.execute({ sql: `SELECT * FROM orders WHERE reference_id = ?`, args: [referenceId] });
        const order = result.rows[0];

        if (!order) {
            return res.status(404).send(`<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;">Order not found</h1>`);
        }

        const items = JSON.parse(order.items || '[]');
        const firstImage = items.find(i => i.img)?.img || 'https://res.cloudinary.com/jojz44tf/image/upload/2mg-sports-park/placeholder.jpg';
        const itemCount = items.reduce((s, i) => s + (i.qty || 1), 0);
        const pageTitle = `Order from ${escapeHtml(order.customer_name)} — 2MG Sports Park`;
        const pageDescription = `${itemCount} item(s) · Total: ${Number(order.total_amount).toLocaleString()} RWF · ${escapeHtml(order.branch || '')}`;
        const pageUrl = `https://twomg-backend.onrender.com/order/${referenceId}`;

        const itemsHtml = items.map(i => `
            <div style="display:flex;align-items:center;gap:14px;background:#111;border-radius:12px;padding:12px;margin-bottom:10px;">
                <img src="${escapeHtml(i.img || '')}" alt="${escapeHtml(i.name || '')}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;background:#222;" />
                <div style="flex:1;">
                    <div style="color:#fff;font-weight:600;">${escapeHtml(i.name || '')}</div>
                    <div style="color:#999;font-size:13px;">${escapeHtml(i.brand || '')} · ×${i.qty || 1}</div>
                </div>
                <div style="color:#e63946;font-weight:700;">${Number((i.price || 0) * (i.qty || 1)).toLocaleString()} RWF</div>
            </div>
        `).join('');

        res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${pageTitle}</title>
    <meta property="og:title" content="${pageTitle}" />
    <meta property="og:description" content="${pageDescription}" />
    <meta property="og:image" content="${escapeHtml(firstImage)}" />
    <meta property="og:url" content="${pageUrl}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { background:#0a0a0a; font-family:'Segoe UI',sans-serif; margin:0; padding:24px; }
        .wrap { max-width:480px; margin:0 auto; }
        .brand { color:#e63946; font-weight:800; font-size:22px; }
        .brand span { color:#fff; }
        .card { background:#161616; border-radius:16px; padding:20px; margin-top:16px; }
        .label { color:#777; font-size:12px; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px; }
        .value { color:#fff; font-size:16px; margin-bottom:14px; }
        .total { display:flex; justify-content:space-between; align-items:center; border-top:1px solid #262626; padding-top:14px; margin-top:14px; }
        .total .amt { color:#e63946; font-size:22px; font-weight:800; }
        .status { display:inline-block; padding:4px 12px; border-radius:20px; background:#3a2a00; color:#ffc93c; font-size:12px; font-weight:700; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="brand">2MG <span>SPORTS PARK</span></div>
        <div class="card">
            <div class="label">Order Reference</div>
            <div class="value">${escapeHtml(order.reference_id)}</div>
            <div class="label">Customer</div>
            <div class="value">${escapeHtml(order.customer_name)}</div>
            <div class="label">Branch</div>
            <div class="value">${escapeHtml(order.branch || 'Not specified')}</div>
            <div class="label">Status</div>
            <div class="value"><span class="status">${escapeHtml(order.status)}</span></div>
        </div>
        <div class="card">
            <div class="label" style="margin-bottom:12px;">Items</div>
            ${itemsHtml}
            <div class="total">
                <span style="color:#999;">Total</span>
                <span class="amt">${Number(order.total_amount).toLocaleString()} RWF</span>
            </div>
        </div>
    </div>
</body>
</html>`);
    } catch (err) {
        console.error("❌ ORDER PAGE ERROR:", err.message);
        res.status(500).send("Something went wrong loading this order.");
    }
});

// ======================
// VIEW ALL ORDERS ROUTE
// ======================
app.get("/orders", async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM orders ORDER BY created_at DESC`);

        const parsed = result.rows.map(o => ({
            ...o,
            items: JSON.parse(o.items)
        }));

        res.json({ success: true, total: parsed.length, orders: parsed });

    } catch (err) {
        console.error("❌ FETCH ORDERS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ======================
// PRODUCTS ROUTES
// ======================
app.get("/categories", (req, res) => {
    const categories = Object.entries(CATEGORY_STRUCTURE).map(([slug, def]) => ({
        slug,
        label: def.label,
        emoji: def.emoji,
        subcategories: Object.entries(def.subcategories).map(([subSlug, subLabel]) => ({ slug: subSlug, label: subLabel }))
    }));
    res.json({ success: true, categories });
});

// ======================
// PRODUCT REQUESTS ROUTES ("can't find it? request it" — from the storefront photos/categories)
// ======================
app.post("/product-requests", async (req, res) => {
    try {
        const { itemName, description, customerName, contactWhatsapp, contactEmail, branch } = req.body;

        if (!itemName || !customerName || !contactWhatsapp) {
            return res.status(400).json({ success: false, error: "Please tell us the item, your name, and a WhatsApp/phone number." });
        }

        await db.execute({
            sql: `INSERT INTO product_requests (item_name, description, customer_name, contact_whatsapp, contact_email, branch) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [itemName.trim(), (description || '').trim(), customerName.trim(), contactWhatsapp.trim(), (contactEmail || '').trim(), branch || '']
        });

        console.log(`📩 PRODUCT REQUEST RECEIVED — "${itemName}" from ${customerName}`);
        res.json({ success: true, message: "Thanks! Your request has been sent — our team will reach out soon." });
    } catch (err) {
        console.error("❌ PRODUCT REQUEST ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/product-requests", verifyAdmin, async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM product_requests ORDER BY created_at DESC`);
        res.json({ success: true, requests: result.rows });
    } catch (err) {
        console.error("❌ FETCH PRODUCT REQUESTS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch("/product-requests/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const allowed = ["NEW", "CONTACTED", "FULFILLED", "CLOSED"];
        if (!allowed.includes(status)) {
            return res.status(400).json({ success: false, error: "Invalid status value." });
        }
        const result = await db.execute({ sql: `UPDATE product_requests SET status = ? WHERE id = ?`, args: [status, id] });
        if (Number(result.rowsAffected) === 0) {
            return res.status(404).json({ success: false, error: "Request not found." });
        }
        console.log(`✅ PRODUCT REQUEST UPDATED — ID: ${id} | Status: ${status}`);
        res.json({ success: true, message: `Request marked as ${status}` });
    } catch (err) {
        console.error("❌ UPDATE PRODUCT REQUEST ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/product-requests/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.execute({ sql: `DELETE FROM product_requests WHERE id = ?`, args: [id] });
        if (Number(result.rowsAffected) === 0) {
            return res.status(404).json({ success: false, error: "Request not found." });
        }
        console.log(`✅ PRODUCT REQUEST DELETED — ID: ${id}`);
        res.json({ success: true, message: "Request deleted." });
    } catch (err) {
        console.error("❌ DELETE PRODUCT REQUEST ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/products", async (req, res) => {
    try {
        const shop = req.query.shop || null;
        let products;
        if (shop) {
            const result = await db.execute({ sql: `SELECT * FROM products WHERE shop = ? ORDER BY id ASC`, args: [shop] });
            products = result.rows;
        } else {
            const result = await db.execute(`SELECT * FROM products ORDER BY id ASC`);
            products = result.rows;
        }

        // Attach every gallery photo to its product (falls back to the single legacy image_url if none were migrated yet)
        const allImagesResult = await db.execute(`SELECT * FROM product_images ORDER BY product_id ASC, sort_order ASC, id ASC`);
        const imagesByProduct = {};
        for (const row of allImagesResult.rows) {
            if (!imagesByProduct[row.product_id]) imagesByProduct[row.product_id] = [];
            imagesByProduct[row.product_id].push({ id: row.id, url: row.image_url });
        }
        products = products.map(p => {
            const gallery = imagesByProduct[p.id] || (p.image_url ? [{ id: null, url: p.image_url }] : []);
            return { ...p, images: gallery };
        });

        res.json({ success: true, products });
    } catch (err) {
        console.error("❌ FETCH PRODUCTS ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/products", verifyAdmin, upload.array('images', 8), async (req, res) => {
    try {
        const { shop, category, subcategory, name, brand, price, badge } = req.body;

        if (!shop || !category || !name || !price) {
            return res.status(400).json({ success: false, error: "Missing required fields: shop, category, name, price" });
        }

        if (!isValidCategory(category)) {
            return res.status(400).json({ success: false, error: `Invalid category. Must be one of: ${Object.keys(CATEGORY_STRUCTURE).join(', ')}` });
        }

        const needsSubcategory = requiresSubcategory(category);
        if (needsSubcategory && !isValidSubcategory(category, subcategory)) {
            return res.status(400).json({ success: false, error: `Invalid subcategory for ${CATEGORY_STRUCTURE[category].label}. Must be one of: ${Object.keys(CATEGORY_STRUCTURE[category].subcategories).join(', ')}` });
        }
        const finalSubcategory = needsSubcategory ? subcategory : '';

        const priceNum = Math.round(Number(price) || 0);
        const priceLabel = `${priceNum.toLocaleString()} RWF`;

        // Upload every attached photo (up to 8) to Cloudinary in parallel
        let imageUrls = [];
        if (req.files && req.files.length) {
            imageUrls = await Promise.all(req.files.map(file => uploadToCloudinary(file.buffer)));
        }
        const primaryImage = imageUrls[0] || '';

        const result = await db.execute({
            sql: `INSERT INTO products (shop, category, subcategory, name, brand, price, price_label, image_url, badge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [shop, category, finalSubcategory, name, brand || '', priceNum, priceLabel, primaryImage, badge || '']
        });

        const newProductId = Number(result.lastInsertRowid);

        // Store every photo (including the primary one) in product_images so the storefront can show a full gallery
        for (let i = 0; i < imageUrls.length; i++) {
            await db.execute({
                sql: `INSERT INTO product_images (product_id, image_url, sort_order) VALUES (?, ?, ?)`,
                args: [newProductId, imageUrls[i], i]
            });
        }

        const newProductResult = await db.execute({ sql: `SELECT * FROM products WHERE id = ?`, args: [newProductId] });
        const newProduct = newProductResult.rows[0];
        newProduct.images = imageUrls;

        console.log(`✅ PRODUCT ADDED — ID: ${newProduct.id} | Name: ${name} | Photos: ${imageUrls.length}`);
        res.json({ success: true, message: "Product added successfully", product: newProduct });
    } catch (err) {
        console.error("❌ ADD PRODUCT ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/products/:id", verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.execute({ sql: `DELETE FROM products WHERE id = ?`, args: [id] });

        if (Number(result.rowsAffected) === 0) {
            return res.status(404).json({ success: false, error: "Product not found" });
        }

        // Clean up the gallery rows too, since Turso doesn't always enforce the FK cascade
        await db.execute({ sql: `DELETE FROM product_images WHERE product_id = ?`, args: [id] });

        // Note: product photos live on Cloudinary now, not local disk, so there's nothing to delete on disk here.
        console.log(`✅ PRODUCT DELETED — ID: ${id}`);
        res.json({ success: true, message: "Product deleted successfully" });
    } catch (err) {
        console.error("❌ DELETE PRODUCT ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.patch("/products/:id", verifyAdmin, upload.array('images', 8), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, brand, category, subcategory, badge, in_stock } = req.body;

        const updates = [];
        const values = [];

        if (name !== undefined) { updates.push(`name = ?`); values.push(name); }
        if (price !== undefined) {
            const priceNum = Math.round(Number(price) || 0);
            updates.push(`price = ?`); values.push(priceNum);
            updates.push(`price_label = ?`); values.push(`${priceNum.toLocaleString()} RWF`);
        }
        if (brand !== undefined) { updates.push(`brand = ?`); values.push(brand); }
        if (category !== undefined) {
            if (!isValidCategory(category)) {
                return res.status(400).json({ success: false, error: `Invalid category. Must be one of: ${Object.keys(CATEGORY_STRUCTURE).join(', ')}` });
            }
            updates.push(`category = ?`); values.push(category);

            const needsSubcategory = requiresSubcategory(category);
            if (needsSubcategory) {
                if (!isValidSubcategory(category, subcategory)) {
                    return res.status(400).json({ success: false, error: `Invalid subcategory for ${CATEGORY_STRUCTURE[category].label}. Must be one of: ${Object.keys(CATEGORY_STRUCTURE[category].subcategories).join(', ')}` });
                }
                updates.push(`subcategory = ?`); values.push(subcategory);
            } else {
                updates.push(`subcategory = ?`); values.push('');
            }
        } else if (subcategory !== undefined) {
            // Category isn't changing, but subcategory alone was — validate against the product's current category
            const currentResult = await db.execute({ sql: `SELECT category FROM products WHERE id = ?`, args: [id] });
            const currentCategory = currentResult.rows[0] ? currentResult.rows[0].category : null;
            if (!currentCategory || !isValidSubcategory(currentCategory, subcategory)) {
                return res.status(400).json({ success: false, error: "Invalid subcategory for this product's category" });
            }
            updates.push(`subcategory = ?`); values.push(subcategory);
        }
        if (badge !== undefined) { updates.push(`badge = ?`); values.push(badge); }
        if (in_stock !== undefined) { updates.push(`in_stock = ?`); values.push(Number(in_stock)); }

        // New photos are appended to the gallery (existing photos stay untouched — use DELETE /products/:id/images/:imageId to remove one)
        let newImageUrls = [];
        if (req.files && req.files.length) {
            newImageUrls = await Promise.all(req.files.map(file => uploadToCloudinary(file.buffer)));
        }
        if (newImageUrls.length) {
            const existingCountResult = await db.execute({ sql: `SELECT COUNT(*) AS count FROM product_images WHERE product_id = ?`, args: [id] });
            let nextOrder = Number(existingCountResult.rows[0].count);
            for (const url of newImageUrls) {
                await db.execute({ sql: `INSERT INTO product_images (product_id, image_url, sort_order) VALUES (?, ?, ?)`, args: [id, url, nextOrder] });
                nextOrder++;
            }
            // Keep the legacy single-image column pointing at the first gallery photo (used as the card thumbnail)
            const firstImageResult = await db.execute({ sql: `SELECT image_url FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1`, args: [id] });
            if (firstImageResult.rows[0]) {
                updates.push(`image_url = ?`); values.push(firstImageResult.rows[0].image_url);
            }
        }
        updates.push(`updated_at = datetime('now', 'localtime')`);

        if (updates.length === 1) {
            return res.status(400).json({ success: false, error: "No fields to update" });
        }

        values.push(id);
        const query = `UPDATE products SET ${updates.join(', ')} WHERE id = ?`;
        const result = await db.execute({ sql: query, args: values });

        if (Number(result.rowsAffected) === 0) {
            return res.status(404).json({ success: false, error: "Product not found" });
        }

        const updatedResult = await db.execute({ sql: `SELECT * FROM products WHERE id = ?`, args: [id] });
        const updated = updatedResult.rows[0];
        const imagesResult = await db.execute({ sql: `SELECT id, image_url FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC`, args: [id] });
        updated.images = imagesResult.rows.map(r => ({ id: r.id, url: r.image_url }));

        console.log(`✅ PRODUCT UPDATED — ID: ${id}`);
        res.json({ success: true, message: "Product updated successfully", product: updated });
    } catch (err) {
        console.error("❌ UPDATE PRODUCT ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Remove a single photo from a product's gallery (admin only)
app.delete("/products/:id/images/:imageId", verifyAdmin, async (req, res) => {
    try {
        const { id, imageId } = req.params;
        const result = await db.execute({ sql: `DELETE FROM product_images WHERE id = ? AND product_id = ?`, args: [imageId, id] });

        if (Number(result.rowsAffected) === 0) {
            return res.status(404).json({ success: false, error: "Image not found for this product" });
        }

        // If we just deleted the photo that the product card thumbnail points to, fall back to whatever photo is now first
        const firstImageResult = await db.execute({ sql: `SELECT image_url FROM product_images WHERE product_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1`, args: [id] });
        const newPrimary = firstImageResult.rows[0] ? firstImageResult.rows[0].image_url : '';
        await db.execute({ sql: `UPDATE products SET image_url = ? WHERE id = ?`, args: [newPrimary, id] });

        console.log(`✅ PRODUCT IMAGE DELETED — Product: ${id} | Image: ${imageId}`);
        res.json({ success: true, message: "Image deleted successfully" });
    } catch (err) {
        console.error("❌ DELETE PRODUCT IMAGE ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ======================
// CUSTOMER AUTH ROUTES
// ======================
app.post("/register", async (req, res) => {
    try {
        const { fullName, whatsappNumber, email, password } = req.body;

        if (!fullName || !whatsappNumber || !email || !password) {
            return res.status(400).json({ success: false, error: "Full name, WhatsApp number, email and password are all required." });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: "Password must be at least 6 characters." });
        }

        const existingResult = await db.execute({ sql: `SELECT id FROM users WHERE email = ?`, args: [email.trim().toLowerCase()] });
        if (existingResult.rows.length > 0) {
            return res.status(409).json({ success: false, error: "An account with this email already exists." });
        }

        const memberId = await generateMemberId();
        const { salt, hash } = hashPassword(password);
        const passwordHash = `${salt}:${hash}`;

        await db.execute({
            sql: `INSERT INTO users (member_id, full_name, whatsapp_number, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
            args: [memberId, fullName.trim(), whatsappNumber.trim(), email.trim().toLowerCase(), passwordHash]
        });

        const token = crypto.randomBytes(32).toString('hex');
        await db.execute({ sql: `INSERT INTO customer_sessions (token, member_id) VALUES (?, ?)`, args: [token, memberId] });

        console.log(`✅ NEW MEMBER REGISTERED — ${memberId} | ${fullName}`);
        res.json({
            success: true,
            message: "Account created successfully",
            token,
            user: { memberId, fullName: fullName.trim(), whatsappNumber: whatsappNumber.trim(), email: email.trim().toLowerCase() }
        });
    } catch (err) {
        console.error("❌ REGISTER ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, error: "Email and password are required." });
        }

        const userResult = await db.execute({ sql: `SELECT * FROM users WHERE email = ?`, args: [email.trim().toLowerCase()] });
        const user = userResult.rows[0];
        if (!user) {
            return res.status(401).json({ success: false, error: "Invalid email or password." });
        }

        const [salt, hash] = (user.password_hash || '').split(':');
        if (!salt || !hash || !verifyPassword(password, salt, hash)) {
            return res.status(401).json({ success: false, error: "Invalid email or password." });
        }

        await db.execute({ sql: `UPDATE users SET last_login = datetime('now', 'localtime') WHERE id = ?`, args: [user.id] });

        const token = crypto.randomBytes(32).toString('hex');
        await db.execute({ sql: `INSERT INTO customer_sessions (token, member_id) VALUES (?, ?)`, args: [token, user.member_id] });

        console.log(`✅ MEMBER LOGGED IN — ${user.member_id}`);
        res.json({
            success: true,
            message: "Logged in successfully",
            token,
            user: { memberId: user.member_id, fullName: user.full_name, whatsappNumber: user.whatsapp_number, email: user.email }
        });
    } catch (err) {
        console.error("❌ LOGIN ERROR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/logout", verifyCustomer, async (req, res) => {
    try {
        const token = req.headers['x-customer-token'];
        await db.execute({ sql: `DELETE FROM customer_sessions WHERE token = ?`, args: [token] });
        res.json({ success: true, message: "Logged out successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/me", verifyCustomer, (req, res) => {
    res.json({
        success: true,
        user: {
            memberId: req.customer.member_id,
            fullName: req.customer.full_name,
            whatsappNumber: req.customer.whatsapp_number,
            email: req.customer.email
        }
    });
});

// ======================
// START SERVER
// ======================
(async () => {
    try {
        console.log("🔧 Connecting to Turso...");
        await setupDatabase();
        console.log("✅ Database ready — connected to Turso");

        console.log("🔧 Seeding admin password...");
        await seedAdminPassword();

        app.listen(PORT, () => {
            console.log(`✅ Server running on port ${PORT}`);
            console.log(`   Currency: ${CURRENCY}`);
            console.log(`   Environment: sandbox`);
        });
    } catch (err) {
        console.error("❌ FAILED TO START SERVER");
        console.error("   Message:", err.message);
        console.error("   Code:", err.code || "(none)");
        console.error("   Full error:", err);
        process.exit(1);
    }
})();
