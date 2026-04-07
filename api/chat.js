const ALLOWED_ORIGIN = 'https://readyradio.com';

const RATE_LIMIT = new Map();
const MAX_REQUESTS = 20;
const WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) {
    RATE_LIMIT.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= MAX_REQUESTS) return true;
  entry.count++;
  RATE_LIMIT.set(ip, entry);
  return false;
}

async function fetchShopifyProducts() {
  const query = `{
    products(first: 100) {
      edges {
        node {
          title
          description
          variants(first: 20) {
            edges {
              node {
                title
                price { amount }
                availableForSale
              }
            }
          }
        }
      }
    }
  }`;

  try {
    const res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    const products = data?.data?.products?.edges || [];

    return products.map(({ node }) => {
      const variants = node.variants.edges.map(({ node: v }) =>
        `${v.title} - $${parseFloat(v.price.amount).toFixed(2)}${v.availableForSale ? '' : ' (out of stock)'}`
      ).join(', ');
      return `Product: ${node.title}\nDescription: ${node.description}\nVariants: ${variants}`;
    }).join('\n\n');
  } catch (e) {
    return '';
  }
}

async function logToGoogleSheets(messages) {
  try {
    const serviceEmail = process.env.GOOGLE_SERVICE_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;

    // Build JWT for Google auth
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: serviceEmail,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = encode(header);
    const claimB64 = encode(claim);
    const signingInput = `${headerB64}.${claimB64}`;

    // Import private key and sign
    const keyData = privateKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');

    const binaryKey = Buffer.from(keyData, 'base64');
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      Buffer.from(signingInput)
    );

    const jwt = `${signingInput}.${Buffer.from(signature).toString('base64url')}`;

    // Exchange JWT for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Format transcript
    const timestamp = new Date().toISOString();
    const transcript = messages
      .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n');

    // Append to sheet
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:B:append?valueInputOption=RAW`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          values: [[timestamp, transcript]],
        }),
      }
    );
  } catch (e) {
    console.error('Sheets logging error:', e);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!origin.includes('readyradio.com')) return res.status(403).json({ error: 'Forbidden' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const { messages, systemPrompt } = req.body;

    // Fetch live Shopify product catalog
    const productContext = await fetchShopifyProducts();

    const fullSystemPrompt = `${systemPrompt}

--- LIVE PRODUCT CATALOG (pulled from readyradio.com right now) ---
${productContext || 'Product catalog temporarily unavailable.'}
--- END CATALOG ---

Always reference the catalog above when answering product questions. If a customer asks about a specific radio model, search the catalog for matching products and variants before responding. Never say a product doesn't exist without checking the catalog first.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: fullSystemPrompt,
        messages,
      }),
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || '';

    // Log full conversation to Google Sheets
    const fullConversation = [
      ...messages,
      { role: 'assistant', content: reply }
    ];
    await logToGoogleSheets(fullConversation);

    return res.status(200).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy error' });
  }
}
