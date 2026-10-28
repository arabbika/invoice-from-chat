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
}
Rules:
- If email not found, use null.
- If quantity not specified, use 1.
- Rate must be a plain number (no currency symbols, no commas).
- If the conversation mentions a total but no line items, create one item named after the work described.
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

    // Generate Sequential Invoice Number (e.g., INV-001)
    let invoice_number = 'INV-001';
    try {
      const { count } = await supabase.from('invoices').select('*', { count: 'exact', head: true });
      invoice_number = `INV-${String((count || 0) + 1).padStart(3, '0')}`;
    } catch (e) {
      console.log("Could not fetch count, defaulting to INV-001");
    }

    // Insert into Database with safe fallbacks
    const { data, error } = await supabase
      .from('invoices')
      .insert([{
        invoice_number,
        client_name: parsed.client?.name || 'Unknown Client', 
        client_email: parsed.client?.email || 'no-email@example.com',
        items: parsed.items,
        subtotal: subtotal,
        currency: parsed.currency || 'ZAR',
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
    console.error('Update error:', err);
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
    console.error('Paystack error:', err);
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
    console.error('Webhook error:', err);
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
      <td style="font-weight: 500;">${escapeHTML(i.description)}</td>
      <td class="num">${i.quantity}</td>
      <td class="num">R${i.rate.toFixed(2)}</td>
      <td class="num" style="font-weight: 600;">R${(i.quantity * i.rate).toFixed(2)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Invoice ${inv.invoice_number || ''} | ${escapeHTML(inv.business_name || 'Arabbika')}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; background: #f4f5f7; margin: 0; padding: 40px 20px; color: #1a1a1a; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 50px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
    
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 50px; }
    .biz-name { font-size: 28px; font-weight: 800; letter-spacing: -1px; margin: 0; }
    .biz-email { color: #6b7280; font-size: 14px; margin-top: 4px; }
    .meta { text-align: right; }
    .meta h1 { font-size: 32px; font-weight: 800; color: #635bff; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 2px; }
    .meta p { margin: 4px 0; color: #6b7280; font-size: 14px; }
    .meta strong { color: #1a1a1a; }

    .bill-to { margin-bottom: 40px; }
    .label { font-size: 12px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; display: block; }
    .client-name { font-size: 18px; font-weight: 600; }
    .client-email { color: #6b7280; font-size: 14px; }

    table { width: 100%; border-collapse: collapse; margin-bottom: 40px; }
    th { text-align: left; padding: 12px 16px; background: #f9fafb; font-size: 12px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #e5e7eb; }
    td { padding: 16px; border-bottom: 1px solid #e5e7eb; font-size: 15px; }
    .num { text-align: right; }
    
    .totals { width: 300px; margin-left: auto; }
    .totals-row { display: flex; justify-content: space-between; padding: 8px 0; color: #6b7280; font-size: 15px; }
    .totals-row.final { border-top: 2px solid #1a1a1a; margin-top: 12px; padding-top: 16px; font-size: 24px; font-weight: 800; color: #1a1a1a; }

    .payment-section { margin-top: 50px; padding-top: 30px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
    .bank-details { font-size: 13px; color: #6b7280; background: #f9fafb; padding: 20px; border-radius: 12px; max-width: 400px; line-height: 1.6; }
    
    .pay-btn { display: block; text-align: center; background: #635bff; color: white; padding: 18px 40px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 18px; transition: background 0.2s; }
    .pay-btn:hover { background: #4f46e5; }
    
    .paid-stamp { color: #16a34a; border: 3px solid #16a34a; padding: 12px 24px; border-radius: 12px; font-weight: 800; display: inline-block; transform: rotate(-5deg); font-size: 28px; letter-spacing: 2px; }
    .paid-container { text-align: center; margin-top: 40px; }

    @media print { 
      body { background: white; padding: 0; } 
      .container { box-shadow: none; padding: 0; } 
      .pay-btn, .payment-section { display: none; } 
    }
  </style></head><body>
    <div class="container">
      
      <div class="header">
        <div>
          ${inv.business_logo ? `<img src="${escapeHTML(inv.business_logo)}" style="height: 60px; margin-bottom: 16px; display: block;">` : ''}
          <h1 class="biz-name">${escapeHTML(inv.business_name || 'Your Business')}</h1>
          <div class="biz-email">${escapeHTML(inv.business_email || '')}</div>
        </div>
        <div class="meta">
          <h1>Invoice</h1>
          <p><strong>#${inv.invoice_number || 'DRAFT'}</strong></p>
          <p>Issued: ${new Date(inv.created_at).toLocaleDateString()}</p>
          <p>Due: <strong>${dueDate}</strong></p>
        </div>
      </div>

      <div class="bill-to">
        <span class="label">Billed To</span>
        <div class="client-name">${escapeHTML(inv.client_name)}</div>
        <div class="client-email">${escapeHTML(inv.client_email)}</div>
      </div>

      <table>
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      
      <div class="totals">
        <div class="totals-row"><span>Subtotal</span> <span>R${inv.subtotal.toFixed(2)}</span></div>
        ${vat > 0 ? `<div class="totals-row"><span>VAT (15%)</span> <span>R${vat.toFixed(2)}</span></div>` : ''}
        <div class="totals-row final"><span>Total</span> <span>R${total.toFixed(2)}</span></div>
      </div>

      <div class="payment-section">
        ${inv.bank_details ? `
          <div class="bank-details">
            <strong style="color: #1a1a1a; font-size: 14px;">Bank Transfer Details</strong><br>
            ${escapeHTML(inv.bank_details).replace(/\n/g, '<br>')}
          </div>
        ` : '<div></div>'}
        
        ${inv.status === 'paid' 
          ? '' 
          : (inv.payment_link ? `<a href="${inv.payment_link}" class="pay-btn">Pay R${total.toFixed(2)} Now</a>` : '')
        }
      </div>

      ${inv.status === 'paid' 
        ? '<div class="paid-container"><div class="paid-stamp">PAID</div></div>' 
        : ''
      }

    </div>
  </body></html>`);
});

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
