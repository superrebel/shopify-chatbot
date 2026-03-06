// server.js - Full-featured backend with admin, analytics, and conversation logging
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'superrebelgear.com';
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret';

// PostgreSQL connection
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Initialize database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL,
      user_message TEXT NOT NULL,
      bot_response TEXT NOT NULL,
      products_shown TEXT,
      feedback VARCHAR(20),
      feedback_note TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_created ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback ON conversations(feedback);
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT
    );
  `);
  
  // Insert default settings if not exist
  const defaults = {
    bot_name: 'Shopping Assistant',
    welcome_message: 'Hey rebel! 👋 What are you shopping for?',
    tone: 'friendly',
    custom_instructions: '',
    restricted_topics: 'math\nweather\nnews\njokes\npolitics',
    faq_responses: 'shipping|Free shipping on orders over €75 (NL/BE). Standard delivery 2-5 business days.\nreturns|30-day return policy. Items must be unworn with tags attached.\nsizes|Check our size guide on each product page. We recommend ordering your regular size.',
    enable_logging: 'true',
    enable_feedback: 'true'
  };
  
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, value]
    );
  }
  
  console.log('Database initialized');
}

// Get setting
async function getSetting(key, defaultValue = '') {
  const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rows[0]?.value ?? defaultValue;
}

// Set setting
async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value]
  );
}

// Product cache
let productsCache = { data: null, timestamp: 0 };
const CACHE_DURATION = 3600000;

// Fetch products from Shopify
async function fetchShopifyProducts(force = false) {
  const now = Date.now();
  if (!force && productsCache.data && (now - productsCache.timestamp) < CACHE_DURATION) {
    return productsCache.data;
  }

  const collections = ['casual', 'performance', 'women', 'men'];
  const allProducts = new Map();

  for (const collection of collections) {
    try {
      const url = `https://${SHOPIFY_STORE}/collections/${collection}/products.json?limit=250`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      if (!data.products) continue;

      for (const product of data.products) {
        if (!allProducts.has(product.id)) {
          allProducts.set(product.id, {
            id: product.id,
            title: product.title,
            handle: product.handle,
            description: product.body_html?.replace(/<[^>]*>/g, '') || '',
            price: `€${parseFloat(product.variants?.[0]?.price || 0).toFixed(2)}`,
            image: product.images?.[0]?.src || '',
            url: `https://${SHOPIFY_STORE}/products/${product.handle}`,
            available: product.available !== false
          });
        }
      }
    } catch (err) {
      console.error(`Error fetching ${collection}:`, err.message);
    }
  }

  const products = Array.from(allProducts.values());
  productsCache = { data: products, timestamp: now };
  return products;
}

// Format products for AI
function formatProductsForAI(products) {
  if (!products?.length) return "No products available.";
  let output = "=== AVAILABLE PRODUCTS ===\n\n";
  for (const p of products) {
    output += `Handle: ${p.handle}\nName: ${p.title}\nPrice: ${p.price}\nStock: ${p.available ? 'Yes' : 'No'}\n\n`;
  }
  return output;
}

// Build system prompt with custom settings
async function buildSystemPrompt() {
  const tone = await getSetting('tone', 'friendly');
  const customInstructions = await getSetting('custom_instructions', '');
  const restrictedTopics = await getSetting('restricted_topics', '');
  const faqResponses = await getSetting('faq_responses', '');

  const toneInstructions = {
    friendly: 'Be friendly, casual, and approachable. Use occasional emojis.',
    professional: 'Be professional and courteous. Avoid slang and emojis.',
    enthusiastic: 'Be enthusiastic and energetic! Show excitement about products.',
    helpful: 'Be helpful and informative. Focus on being useful above all.'
  };

  let prompt = `You are a shopping assistant for SuperRebel Gear ONLY.

TONE: ${toneInstructions[tone] || toneInstructions.friendly}

CRITICAL RULES:

1. TOPIC RESTRICTION:
   - ONLY answer: SuperRebel products, clothing, shopping, sizes, shipping, returns
   - If asked ANYTHING else, respond:
     "I'm your SuperRebel Gear shopping assistant! I can only help with our products. What are you looking for?"`;

  if (restrictedTopics) {
    const topics = restrictedTopics.split('\n').map(t => t.trim()).filter(Boolean);
    if (topics.length) {
      prompt += `\n   - RESTRICTED TOPICS (redirect politely): ${topics.join(', ')}`;
    }
  }

  prompt += `

2. PRODUCT FORMAT - VERY IMPORTANT:
   When showing products, DO NOT use numbered lists (1. 2. 3.)
   
   CORRECT FORMAT:
   "Here are items under €50:
   [PRODUCT:keanu-black|KEANU_ Black Tee|€49.00]
   [PRODUCT:marlon|MARLON_ Logo Tee|€49.00]
   
   Perfect choices for everyday wear!"
   
   Rules:
   - Use [PRODUCT:handle|name|price] format for EVERY product
   - Do NOT number them (no 1. 2. 3.)

3. NO HALLUCINATIONS:
   - Only mention products from the product list
   - Use exact handles from the list`;

  if (faqResponses) {
    const faqs = faqResponses.split('\n').map(f => f.trim()).filter(Boolean);
    if (faqs.length) {
      prompt += '\n\nFAQ RESPONSES (use these for consistency):';
      for (const faq of faqs) {
        const [keyword, response] = faq.split('|');
        if (keyword && response) {
          prompt += `\n- ${keyword.trim()}: ${response.trim()}`;
        }
      }
    }
  }

  prompt += `\n\nSTORE INFO:
- Shipping: Free over €75 (NL/BE)
- Returns: 30-day policy
- Email: info@superrebelgear.com`;

  if (customInstructions) {
    prompt += `\n\nADDITIONAL INSTRUCTIONS:\n${customInstructions}`;
  }

  return prompt;
}

// Extract products from AI response
function extractProducts(text, allProducts) {
  const products = [];
  const regex = /\[PRODUCT:([^\|]+)\|([^\|]+)\|([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const handle = match[1].trim();
    const product = allProducts.find(p => p.handle === handle);
    if (product) products.push(product);
  }
  return products;
}

// Log conversation
async function logConversation(sessionId, userMsg, botResponse, products, ip, userAgent) {
  const enableLogging = await getSetting('enable_logging', 'true');
  if (enableLogging !== 'true') return null;

  const result = await pool.query(
    `INSERT INTO conversations (session_id, user_message, bot_response, products_shown, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [sessionId, userMsg, botResponse, products.length ? JSON.stringify(products) : null, ip, userAgent]
  );
  return result.rows[0].id;
}

// ============ API ROUTES ============

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, session_id, history = [] } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'API key not configured' });

    const products = await fetchShopifyProducts();
    const systemPrompt = await buildSystemPrompt() + '\n\n' + formatProductsForAI(products);

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10),
      { role: 'user', content: message }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 800,
      temperature: 0.3
    });

    let aiResponse = response.choices[0]?.message?.content || '';
    aiResponse = aiResponse.replace(/^\d+\.\s*/gm, '');

    const extractedProducts = extractProducts(aiResponse, products);
    const sessionId = session_id || crypto.randomUUID();
    const convId = await logConversation(
      sessionId, message, aiResponse, extractedProducts,
      req.ip, req.headers['user-agent']
    );

    const enableFeedback = await getSetting('enable_feedback', 'true');

    res.json({
      response: aiResponse,
      products: extractedProducts,
      conversation_id: convId,
      session_id: sessionId,
      enable_feedback: enableFeedback === 'true'
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// Feedback endpoint
app.post('/api/feedback', async (req, res) => {
  try {
    const { conversation_id, feedback, note } = req.body;
    if (!['positive', 'negative'].includes(feedback)) {
      return res.status(400).json({ error: 'Invalid feedback' });
    }
    await pool.query(
      'UPDATE conversations SET feedback = $1, feedback_note = $2 WHERE id = $3',
      [feedback, note || '', conversation_id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ============ ADMIN ROUTES ============

// Admin auth middleware
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get all settings
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM settings');
  const settings = {};
  result.rows.forEach(row => settings[row.key] = row.value);
  res.json(settings);
});

// Update settings
app.post('/api/admin/settings', adminAuth, async (req, res) => {
  const { settings } = req.body;
  for (const [key, value] of Object.entries(settings)) {
    await setSetting(key, value);
  }
  res.json({ success: true });
});

// Get conversations
app.get('/api/admin/conversations', adminAuth, async (req, res) => {
  const { page = 1, limit = 20, feedback, date, search } = req.query;
  const offset = (page - 1) * limit;
  
  let where = 'WHERE 1=1';
  const params = [];
  let paramCount = 0;

  if (feedback) {
    params.push(feedback);
    where += ` AND feedback = $${++paramCount}`;
  }
  if (date) {
    params.push(date);
    where += ` AND DATE(created_at) = $${++paramCount}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (user_message ILIKE $${paramCount} OR bot_response ILIKE $${paramCount})`;
    paramCount++;
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM conversations ${where}`, params);
  const total = parseInt(countResult.rows[0].count);

  params.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM conversations ${where} ORDER BY created_at DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`,
    params
  );

  res.json({
    conversations: result.rows,
    total,
    pages: Math.ceil(total / limit),
    page: parseInt(page)
  });
});

// Delete conversations
app.delete('/api/admin/conversations', adminAuth, async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No IDs provided' });
  await pool.query('DELETE FROM conversations WHERE id = ANY($1)', [ids]);
  res.json({ success: true, deleted: ids.length });
});

// Export conversations CSV
app.get('/api/admin/export', adminAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM conversations ORDER BY created_at DESC');
  
  const csv = [
    'ID,Session,User Message,Bot Response,Products,Feedback,Note,Date',
    ...result.rows.map(r => [
      r.id,
      r.session_id,
      `"${(r.user_message || '').replace(/"/g, '""')}"`,
      `"${(r.bot_response || '').replace(/"/g, '""')}"`,
      `"${r.products_shown || ''}"`,
      r.feedback || '',
      `"${(r.feedback_note || '').replace(/"/g, '""')}"`,
      r.created_at
    ].join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=conversations-${new Date().toISOString().split('T')[0]}.csv`);
  res.send(csv);
});

// Analytics
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  const [total, positive, negative, today, week, common, recentNegative] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM conversations'),
    pool.query("SELECT COUNT(*) FROM conversations WHERE feedback = 'positive'"),
    pool.query("SELECT COUNT(*) FROM conversations WHERE feedback = 'negative'"),
    pool.query('SELECT COUNT(*) FROM conversations WHERE DATE(created_at) = CURRENT_DATE'),
    pool.query("SELECT COUNT(*) FROM conversations WHERE created_at >= NOW() - INTERVAL '7 days'"),
    pool.query('SELECT user_message, COUNT(*) as count FROM conversations GROUP BY user_message ORDER BY count DESC LIMIT 10'),
    pool.query("SELECT user_message, bot_response, feedback_note, created_at FROM conversations WHERE feedback = 'negative' ORDER BY created_at DESC LIMIT 10")
  ]);

  res.json({
    total: parseInt(total.rows[0].count),
    positive: parseInt(positive.rows[0].count),
    negative: parseInt(negative.rows[0].count),
    today: parseInt(today.rows[0].count),
    week: parseInt(week.rows[0].count),
    common_questions: common.rows,
    recent_negative: recentNegative.rows
  });
});

// Health check
app.get('/api/health', async (req, res) => {
  const products = await fetchShopifyProducts();
  res.json({ status: 'ok', products: products.length, store: SHOPIFY_STORE });
});

// Clear cache
app.post('/api/admin/clear-cache', adminAuth, (req, res) => {
  productsCache = { data: null, timestamp: 0 };
  res.json({ success: true });
});

// Initialize and start
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`SuperRebel Chatbot API v3 running on port ${PORT}`));
});

export default app;
