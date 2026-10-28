let currentInvoiceId = null;

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('biz-name').value = localStorage.getItem('bizName') || '';
  document.getElementById('biz-email').value = localStorage.getItem('bizEmail') || '';
  document.getElementById('biz-logo').value = localStorage.getItem('bizLogo') || '';
  document.getElementById('bank-details').value = localStorage.getItem('bankDetails') || '';
});

function saveSettings() {
  localStorage.setItem('bizName', document.getElementById('biz-name').value);
  localStorage.setItem('bizEmail', document.getElementById('biz-email').value);
  localStorage.setItem('bizLogo', document.getElementById('biz-logo').value);
  localStorage.setItem('bankDetails', document.getElementById('bank-details').value);
}

function loadSample() {
  document.getElementById('chat').value = `Client: Hey! I need a landing page redesign and a new logo by Friday.
Me: Sure — R500 for the landing page and R200 for the logo.
Client: Deal. Send the invoice to john@acme.com`;
}

document.getElementById('generate-btn').addEventListener('click', async () => {
  const chat = document.getElementById('chat').value.trim();
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  if (chat.length < 20) { errorEl.textContent = 'Paste a longer conversation.'; return; }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true; btn.textContent = 'AI is reading...';

  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to parse');

    currentInvoiceId = data.invoiceId;
    populateEditablePreview(data.invoice);
    
    document.getElementById('input-section').style.display = 'none';
    document.getElementById('result-section').style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Generate Invoice';
  }
});

function populateEditablePreview(inv) {
  document.getElementById('edit-client-name').value = inv.client_name || '';
  document.getElementById('edit-client-email').value = inv.client_email !== 'no-email@example.com' ? inv.client_email : '';
  
  const container = document.getElementById('edit-items-container');
  container.innerHTML = '';
  inv.items.forEach((item) => addItem(item.description, item.quantity, item.rate));

  updateTotal();
}

function addItem(desc = '', qty = 1, rate = 0) {
  const container = document.getElementById('edit-items-container');
  const row = document.createElement('div');
  row.className = 'item-row';
  row.style.cssText = 'display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 12px; margin-bottom: 12px;';
  row.innerHTML = `
    <input type="text" class="item-desc" placeholder="Description" value="${escapeHTML(desc)}" style="padding:10px; border:1px solid #ddd; border-radius:8px;">
    <input type="number" class="item-qty" placeholder="Qty" value="${qty}" min="1" oninput="updateTotal()" style="padding:10px; border:1px solid #ddd; border-radius:8px;">
    <input type="number" class="item-rate" placeholder="Rate" value="${rate}" min="0" oninput="updateTotal()" style="padding:10px; border:1px solid #ddd; border-radius:8px;">
    <button onclick="this.parentElement.remove(); updateTotal();" style="background: #fee2e2; color: #dc2626; padding: 0 12px; margin: 0; height: 100%;">×</button>
  `;
  container.appendChild(row);
}

function updateTotal() {
  let subtotal = 0;
  document.querySelectorAll('.item-row').forEach(row => {
    const qty = Number(row.querySelector('.item-qty').value) || 0;
    const rate = Number(row.querySelector('.item-rate').value) || 0;
    subtotal += qty * rate;
  });
  
  const vatPercent = Number(document.getElementById('edit-vat').value);
  const vatAmount = subtotal * (vatPercent / 100);
  const total = subtotal + vatAmount;

  document.getElementById('edit-subtotal').textContent = subtotal.toFixed(2);
  document.getElementById('edit-total').textContent = total.toFixed(2);
  
  if (vatPercent > 0) {
    document.getElementById('vat-display').style.display = 'block';
    document.getElementById('edit-vat-amount').textContent = vatAmount.toFixed(2);
  } else {
    document.getElementById('vat-display').style.display = 'none';
  }
}

document.getElementById('edit-vat').addEventListener('change', updateTotal);

document.getElementById('save-and-link-btn').addEventListener('click', async () => {
  if (!currentInvoiceId) return;

  const clientName = document.getElementById('edit-client-name').value;
  const clientEmail = document.getElementById('edit-client-email').value;
  
  if (!clientEmail) return alert('Client email is required to create a payment link.');

  const items = [];
  document.querySelectorAll('.item-row').forEach(row => {
    items.push({
      description: row.querySelector('.item-desc').value,
      quantity: Number(row.querySelector('.item-qty').value),
      rate: Number(row.querySelector('.item-rate').value)
    });
  });

  let subtotal = items.reduce((s, i) => s + (i.quantity * i.rate), 0);
  const vatPercent = Number(document.getElementById('edit-vat').value);
  const vatAmount = subtotal * (vatPercent / 100);

  const payload = { 
    client_name: clientName, 
    client_email: clientEmail, 
    items,
    business_name: document.getElementById('biz-name').value,
    business_logo: document.getElementById('biz-logo').value,
    business_email: document.getElementById('biz-email').value,
    bank_details: document.getElementById('bank-details').value,
    vat_amount: vatAmount,
    due_days: document.getElementById('edit-due-days').value
  };

  const btn = document.getElementById('save-and-link-btn');
  btn.disabled = true; btn.textContent = 'Saving & creating link...';

  try {
    // 1. Update the invoice
    const updateRes = await fetch(`/api/invoice/${currentInvoiceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!updateRes.ok) throw new Error('Failed to save changes');

    // 2. Create the link
    const linkRes = await fetch(`/api/invoice/${currentInvoiceId}/payment-link`, { method: 'POST' });
    const linkData = await linkRes.json();
    if (!linkRes.ok) throw new Error(linkData.error);

    document.getElementById('payment-result').innerHTML = `
      <div class="success-box">
        ✅ Invoice saved and payment link ready!
        <div style="display:flex; gap:10px; margin-top: 12px;">
          <a href="${linkData.paymentLink}" target="_blank" class="btn-primary" style="text-decoration:none; padding: 10px 16px; text-align:center; background:#635bff; color:white; border-radius:8px; font-size:14px;">Pay Link</a>
          <button onclick="sendWhatsApp('${linkData.paymentLink}')" style="background:#25D366; color:white; padding: 10px 16px; font-size:14px;">Send on WhatsApp</button>
        </div>
      </div>`;
      
    document.getElementById('view-invoice-btn').href = `/api/view/${currentInvoiceId}`;

  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Create Payment Link';
  }
});

function sendWhatsApp(link) {
  const bizName = document.getElementById('biz-name').value || 'your business';
  const clientName = document.getElementById('edit-client-name').value;
  const text = `Hi ${clientName}, here is the invoice from ${bizName}. You can view and pay it here: ${link}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
