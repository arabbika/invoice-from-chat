require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ 
  apiKey: process.env.XAI_API_KEY, 
  baseURL: "https://api.x.ai/v1" 
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 1. Parse Chat
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
}`
        },
        { role: 'user', content: `Extract invoice details:\n\n${chat}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    const parsed = JSON.parse(completion.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim());
    const subtotal = parsed.items.reduce((s, i) => s + i.quantity * i.rate, 0);

    // Generate Sequential Invoice Number (e.g., INV-001)
    const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true });
    const invoice_number = `INV-${String((count || 0) + 1).padStart(3, '0')}`;

    const { data, error } = await supabase
      .from('invoices')
      .insert([{
        invoice_number,
        client_name: parsed.client.name,
        client_email: parsed.client.email || 'no-email@example.com',
        items: parsed.items,
        subtotal: subtotal,
        currency: parsed.currency,
        status: 'draft'
      }]).select().single();

    if (error) throw error;
    res.json({ invoiceId: data.id, invoice: data });

  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse chat. Try again.' });
  }
});

// 2. Update Invoice (Includes VAT, Due Dates, Bank Details)
app.put('/api/invoice/:id', async (req, res) => {
  try {
    const { 
      client_name, client_email, items, 
      business_name, business_logo, business_email, bank_details,
      vat_amount, due_days 
    } = req.body;
    
    const subtotal = items.reduce((s, i) => s + i.quantity * i.rate, 0);

    const { data, error } = await supabase
      .from('invoices')
      .update({ 
        client_name, client_email, items, subtotal,
        business_name, business_logo, business_email, bank_details,
        vat_amount: Number(vat_amount) || 0, due_days: Number(due_days) || 14
      })
      .eq('id', req.params.id).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update invoice.' });
  }
});

// 3. Create Paystack Link
app.post('/api/invoice/:id/payment-link', async (req, res) => {
  try {
    const { data: invoice, error } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
    if (error || !invoice) return res.status(404).json({ error: 'Invoice not found' });

    const total = invoice.subtotal + (invoice.vat_amount || 0);

    const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: invoice.client_email,
        amount: Math.round(total * 100),
        currency: 'ZAR',
        callback_url: `${process.env.BASE_URL}/success.html?id=${invoice.id}`,
        metadata: { invoiceId: invoice.id }
      })
    });

    const paystackData = await paystackResponse.json();
    if (!paystackData.status) throw new Error('Paystack failed');

    await supabase.from('invoices').update({ payment_link: paystackData.data.authorization_url, status: 'sent' }).eq('id', invoice.id);

    res.json({ paymentLink: paystackData.data.authorization_url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

// 4. Paystack Webhook
app.post('/api/webhook', async (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.status(401).send('Invalid signature');

    const event = JSON.parse(req.body.toString());
    if (event.event === 'charge.success') {
      await supabase.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', event.data.metadata.invoiceId);
    }
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

// 5. Public Premium Invoice View
app.get('/api/view/:id', async (req, res) => {
  const { data: inv, error } = await supabase.from('invoices').select('*').eq('id', req.params.id).single();
  if (error || !inv) return res.status(404).send('Invoice not found');

  const vat = inv.vat_amount || 0;
  const total = inv.subtotal + vat;
  const dueDate = new Date(new Date(inv.created_at).getTime() + (inv.due_days || 14) * 86400000).toLocaleDateString();

  const rows = inv.items.map(i => `
    <tr>
      <td>${escapeHTML(i.description)}</td>
      <td class="num">${i.quantity}</td>
      <td class="num">${i.rate.toFixed(2)}</td>
      <td class="num">${(i.quantity * i.rate).toFixed(2)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Invoice ${inv.invoice_number}</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#f7f7f9;margin:0;padding:40px 20px;color:#1a1a1a}
    .container{max-width:700px;margin:0 auto;background:white;padding:40px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.05)}
    .header{display:flex;justify-content:space-between;align-items:start;margin-bottom:40px}
    h1{margin:0;font-size:28px;color:#635bff}.meta{text-align:right;color:#666;font-size:14px}
    .biz-info{display:flex;align-items:center;gap:12px;margin-bottom:10px}
    .biz-logo{width:50px;height:50px;object-fit:contain;border-radius:8px}
    .biz-name{font-size:20px;font-weight:bold}
    table{width:100%;border-collapse:collapse;margin:20px 0}
    th{text-align:left;padding:12px 8px;border-bottom:2px solid #eee;font-size:12px;color:#888;text-transform:uppercase}
    td{padding:16px 8px;border-bottom:1px solid #eee;font-size:15px}.num{text-align:right}
    .totals{margin-top:20px;text-align:right;line-height:1.8}
    .total-row{font-size:24px;font-weight:800;color:#1a1a1a}
    .pay-btn{display:block;text-align:center;background:#635bff;color:white;padding:16px;border-radius:12px;text-decoration:none;font-weight:600;margin-top:30px;font-size:16px}
    .paid-stamp{color: #16a34a; border: 3px solid #16a34a; padding: 10px 20px; border-radius: 8px; font-weight: 800; display: inline-block; margin-top: 30px; transform: rotate(-5deg); font-size: 24px;}
    .bank-details{margin-top:30px;padding:20px;background:#f8f9fa;border-radius:12px;font-size:14px;color:#555;border:1px dashed #ccc}
    @media print { body{background:white;padding:0} .container{box-shadow:none;padding:0} .pay-btn{display:none} }
  </style></head><body>
    <div class="container">
      <div class="header">
        <div>
          <div class="biz-info">
            ${inv.business_logo ? `<img src="${escapeHTML(inv.business_logo)}" class="biz-logo">` : ''}
            <div class="biz-name">${escapeHTML(inv.business_name || 'Your Business')}</div>
          </div>
          ${inv.business_email ? `<div style="color:#666;font-size:14px">${escapeHTML(inv.business_email)}</div>` : ''}
        </div>
        <div class="meta">
          <h1>INVOICE</h1>
          <div><strong>#${inv.invoice_number || 'DRAFT'}</strong></div>
          <div>Date: ${new Date(inv.created_at).toLocaleDateString()}</div>
          <div>Due: ${dueDate}</div>
        </div>
      </div>
      
      <div style="margin-bottom:30px">
        <div style="font-size:12px;color:#888;text-transform:uppercase;font-weight:bold;margin-bottom:4px">Bill To</div>
        <div style="font-weight:600;font-size:16px">${escapeHTML(inv.client_name)}</div>
        <div style="color:#666;font-size:14px">${escapeHTML(inv.client_email)}</div>
      </div>

      <table>
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      
      <div class="totals">
        <div>Subtotal: R${inv.subtotal.toFixed(2)}</div>
        ${vat > 0 ? `<div>VAT (15%): R${vat.toFixed(2)}</div>` : ''}
        <div class="total-row">Total: ${inv.currency} ${total.toFixed(2)}</div>
      </div>

      ${inv.bank_details ? `
        <div class="bank-details">
          <strong>Bank Transfer Details:</strong><br>
          ${escapeHTML(inv.bank_details).replace(/\n/g, '<br>')}
        </div>
      ` : ''}
      
      ${inv.status === 'paid' 
        ? '<div style="text-align:center"><div class="paid-stamp">PAID</div></div>' 
        : (inv.payment_link ? `<a href="${inv.payment_link}" class="pay-btn">Pay Now (Card)</a>` : '')
      }
    </div>
  </body></html>`);
});

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
