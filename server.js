require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// xAI Configuration (using the OpenAI SDK)
const openai = new OpenAI({ 
  apiKey: process.env.XAI_API_KEY, 
  baseURL: "https://api.x.ai/v1" 
});

// In-memory store for invoices (Note: resets when server restarts)
const invoices = new Map();

// 1. Parse Chat with xAI (Grok)
app.post('/api/parse', async (req, res) => {
  try {
    const { chat } = req.body;
    if (!chat || chat.length < 20) {
      return res.status(400).json({ error: 'Paste a longer conversation.' });
    }

    const completion = await openai.chat.completions.create({
      model: 'grok-3', // xAI model name
      messages: [
        {
          role: 'system',
          content: `You extract invoice data from chat conversations.
Return ONLY valid JSON matching this exact structure:
{
  "client": { "name": "string", "email": "string or null" },
  "items": [{ "description": "string", "quantity": number, "rate": number }],
  "currency": "ZAR",
  "notes": "string"
}
Rules:
- If email not found, use null.
- If quantity not specified, use 1.
- Rate must be a plain number (no currency symbols, no commas).
- If the conversation mentions a total but no line items, create one item named after the work described.
- Default currency is ZAR.
- notes should summarize the work briefly, or be empty string.`
        },
        { role: 'user', content: `Extract invoice details:\n\n${chat}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    // Clean potential markdown backticks from Grok's response
    const rawContent = completion.choices[0].message.content;
    const cleanContent = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    const subtotal = parsed.items.reduce((s, i) => s + i.quantity * i.rate, 0);
    const invoiceId = randomUUID().slice(0, 8);

    invoices.set(invoiceId, {
      ...parsed,
      subtotal,
      invoiceId,
      createdAt: new Date().toISOString(),
      status: 'draft'
    });

    res.json({ invoiceId, invoice: invoices.get(invoiceId) });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse chat. Try again.' });
  }
});

// 2. Get Invoice Data (API)
app.get('/api/invoice/:id', (req, res) => {
  const invoice = invoices.get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json(invoice);
});

// 3. Create Paystack Payment Link
app.post('/api/invoice/:id/payment-link', async (req, res) => {
  try {
    const invoice = invoices.get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Not found' });

    const customerEmail = invoice.client.email || 'customer@example.com';

    const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: Math.round(invoice.subtotal * 100), // Amount in cents
        currency: 'ZAR',
        callback_url: `${process.env.BASE_URL}/success.html?id=${invoice.invoiceId}`,
        metadata: {
          invoiceId: invoice.invoiceId,
          clientName: invoice.client.name
        }
      })
    });

    const paystackData = await paystackResponse.json();

    if (!paystackData.status) {
      throw new Error(paystackData.message || 'Paystack initialization failed');
    }

    invoice.paymentLink = paystackData.data.authorization_url;
    invoice.status = 'sent';
    invoices.set(invoice.invoiceId, invoice);

    res.json({ paymentLink: invoice.paymentLink });
  } catch (err) {
    console.error('Paystack error:', err);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

// 4. Printable Invoice View
app.get('/invoice/:id', (req, res) => {
  const inv = invoices.get(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found');

  // Grab business details from URL parameters (sent from frontend)
  const bizName = req.query.name || 'Your Business';
  const bizLogo = req.query.logo || '';
  const bizEmail = req.query.email || '';

  const rows = inv.items.map(i => `
    <tr>
      <td>${escapeHTML(i.description)}</td>
      <td class="num">${i.quantity}</td>
      <td class="num">${i.rate.toFixed(2)}</td>
      <td class="num">${(i.quantity * i.rate).toFixed(2)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Invoice ${inv.invoiceId}</title>
  <style>
    body{font-family:-apple-system,sans-serif;max-width:700px;margin:40px auto;padding:20px;color:#1a1a1a}
    .header{display:flex;justify-content:space-between;align-items:start;margin-bottom:40px}
    h1{margin:0;font-size:28px}.meta{text-align:right;color:#666;font-size:14px}
    .biz-info{display:flex;align-items:center;gap:12px;margin-bottom:10px}
    .biz-logo{width:50px;height:50px;object-fit:contain;border-radius:4px}
    .biz-name{font-size:20px;font-weight:bold}
    table{width:100%;border-collapse:collapse;margin:20px 0}
    th{text-align:left;padding:10px;border-bottom:2px solid #eee;font-size:13px;color:#666;text-transform:uppercase}
    td{padding:12px 10px;border-bottom:1px solid #eee}.num{text-align:right}
    .total{text-align:right;font-size:20px;font-weight:bold;padding:20px 10px}
    .pay-btn{display:inline-block;background:#635bff;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:20px}
    .notes{margin-top:30px;padding:15px;background:#f7f7f9;border-radius:8px;font-size:14px;color:#555}
  </style></head><body>
    <div class="header">
      <div>
        <div class="biz-info">
          ${bizLogo ? `<img src="${escapeHTML(bizLogo)}" class="biz-logo" alt="Logo">` : ''}
          <div class="biz-name">${escapeHTML(bizName)}</div>
        </div>
        ${bizEmail ? `<div style="color:#666;font-size:14px">${escapeHTML(bizEmail)}</div>` : ''}
        <div style="color:#666;font-size:14px;margin-top:20px">Invoice #${inv.invoiceId}</div>
      </div>
      <div class="meta">
        <div><strong>Bill To:</strong></div>
        <div>${escapeHTML(inv.client.name)}</div>
        ${inv.client.email ? `<div>${escapeHTML(inv.client.email)}</div>` : ''}
        <div style="margin-top:10px">Date: ${new Date(inv.createdAt).toLocaleDateString()}</div>
      </div>
    </div>
    <table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="total">Total: ${inv.currency} ${inv.subtotal.toFixed(2)}</div>
    ${inv.notes ? `<div class="notes">${escapeHTML(inv.notes)}</div>` : ''}
    ${inv.paymentLink ? `<a href="${inv.paymentLink}" class="pay-btn">Pay Now</a>` : ''}
  </body></html>`);
});

// Helper function to prevent XSS
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 5. Start the Server (Updated for Cloud Hosting)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
