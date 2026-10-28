require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
// Paystack webhooks need the raw body to verify signatures
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

// Initialize Clients
const openai = new OpenAI({ 
  apiKey: process.env.XAI_API_KEY, 
  baseURL: "https://api.x.ai/v1" 
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Parse Chat with xAI (Grok)
app.post('/api/parse', async (req, res) => {
  try {
    const { chat } = req.body;
    if (!chat || chat.length < 20) return res.status(400).json({ error: 'Paste a longer conversation.' });

    const completion = await openai.chat.completions.create({
      model: 'grok-3',
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
- Rate must be a plain number.
- Default currency is ZAR.`
        },
        { role: 'user', content: `Extract invoice details:\n\n${chat}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    const rawContent = completion.choices[0].message.content;
    const cleanContent = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    const subtotal = parsed.items.reduce((s, i) => s + i.quantity * i.rate, 0);

    // Save to Supabase
    const { data, error } = await supabase
      .from('invoices')
      .insert([{
        client_name: parsed.client.name,
        client_email: parsed.client.email || 'no-email@example.com',
        items: parsed.items,
        subtotal: subtotal,
        currency: parsed.currency,
        status: 'draft'
      }])
      .select()
      .single();

    if (error) throw error;
    res.json({ invoiceId: data.id, invoice: data });

  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse chat. Try again.' });
  }
});

// 2. Update Invoice (For Editable Preview)
app.put('/api/invoice/:id', async (req, res) => {
  try {
    const { client_name, client_email, items, business_name, business_logo, business_email } = req.body;
    
    const subtotal = items.reduce((s, i) => s + i.quantity * i.rate, 0);

    const { data, error } = await supabase
      .from('invoices')
      .update({ 
        client_name, client_email, items, subtotal,
        business_name, business_logo, business_email 
      })
      .eq('id', req.params.id)
      .select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update invoice.' });
  }
});

// 3. Create Paystack Payment Link
app.post('/api/invoice/:id/payment-link', async (req, res) => {
  try {
    const { data: invoice, error } = await supabase
      .from('invoices').select('*').eq('id', req.params.id).single();
      
    if (error || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: invoice.client_email,
        amount: Math.round(invoice.subtotal * 100),
        currency: 'ZAR',
        callback_url: `${process.env.BASE_URL}/success.html?id=${invoice.id}`,
        metadata: { invoiceId: invoice.id }
      })
    });

    const paystackData = await paystackResponse.json();
    if (!paystackData.status) throw new Error(paystackData.message || 'Paystack failed');

    await supabase.from('invoices')
      .update({ payment_link: paystackData.data.authorization_url, status: 'sent' })
      .eq('id', invoice.id);

    res.json({ paymentLink: paystackData.data.authorization_url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

// 4. PAYSTACK WEBHOOK (The critical trust feature)
app.post('/api/webhook', async (req, res) => {
  try {
    // Verify the event is genuinely from Paystack
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success') {
      const invoiceId = event.data.metadata.invoiceId;
      
      // Update the database to mark as paid
      await supabase.from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', invoiceId);
    }
    
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// 5. Public Invoice View
app.get('/api/view/:id', async (req, res) => {
  const { data: inv, error } = await supabase
    .from('invoices').select('*').eq('id', req.params.id).single();
    
  if (error || !inv) return res.status(404).send('Invoice not found');

  const rows = inv.items.map(i => `
    <tr>
      <td>${escapeHTML(i.description)}</td>
      <td class="num">${i.quantity}</td>
      <td class="num">${i.rate.toFixed(2)}</td>
      <td class="num">${(i.quantity * i.rate).toFixed(2)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Invoice ${inv.id.slice(0,8)}</title>
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
    .paid-stamp{color: #16a34a; border: 2px solid #16a34a; padding: 8px 16px; border-radius: 8px; font-weight: bold; display: inline-block; margin-top: 20px;}
  </style></head><body>
    <div class="header">
      <div>
        <div class="biz-info">
          ${inv.business_logo ? `<img src="${escapeHTML(inv.business_logo)}" class="biz-logo" alt="Logo">` : ''}
          <div class="biz-name">${escapeHTML(inv.business_name || 'Your Business')}</div>
        </div>
        ${inv.business_email ? `<div style="color:#666;font-size:14px">${escapeHTML(inv.business_email)}</div>` : ''}
      </div>
      <div class="meta">
        <div><strong>Bill To:</strong></div>
        <div>${escapeHTML(inv.client_name)}</div>
        <div>${escapeHTML(inv.client_email)}</div>
      </div>
    </div>
    <table>
      <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="total">Total: ${inv.currency} ${inv.subtotal.toFixed(2)}</div>
    
    ${inv.status === 'paid' 
      ? '<div class="paid-stamp">PAID</div>' 
      : (inv.payment_link ? `<a href="${inv.payment_link}" class="pay-btn">Pay Now</a>` : '')
    }
  </body></html>`);
});

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
