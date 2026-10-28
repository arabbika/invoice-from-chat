let currentInvoiceId = null;

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('biz-name').value = localStorage.getItem('bizName') || '';
  document.getElementById('biz-email').value = localStorage.getItem('bizEmail') || '';
  document.getElementById('biz-logo').value = localStorage.getItem('bizLogo') || '';
});

function saveSettings() {
  localStorage.setItem('bizName', document.getElementById('biz-name').value);
  localStorage.setItem('bizEmail', document.getElementById('biz-email').value);
  localStorage.setItem('bizLogo', document.getElementById('biz-logo').value);
}

document.getElementById('generate-btn').addEventListener('click', async () => {
  const chat = document.getElementById('chat').value.trim();
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  if (chat.length < 20) { errorEl.textContent = 'Paste a longer conversation.'; return; }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true; btn.textContent = 'Parsing with AI...';

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
  inv.items.forEach((item, index) => addItem(item.description, item.quantity, item.rate));

  updateTotal();
}

function addItem(desc = '', qty = 1, rate = 0) {
  const container = document.getElementById('edit-items-container');
  const row = document.createElement('div');
  row.className = 'item-row';
  row.style.cssText = 'display: grid; grid-template-columns: 2fr 1fr 1fr auto; gap: 8px; margin-bottom: 8px;';
  row.innerHTML = `
    <input type="text" class="item-desc" placeholder="Description" value="${escapeHTML(desc)}">
    <input type="number" class="item-qty" placeholder="Qty" value="${qty}" min="1" oninput="updateTotal()">
    <input type="number" class="item-rate" placeholder="Rate" value="${rate}" min="0" oninput="updateTotal()">
    <button onclick="this.parentElement.remove(); updateTotal();" style="background: #fee2e2; color: #dc2626; padding: 0 12px; margin: 0;">×</button>
  `;
  container.appendChild(row);
}

function updateTotal() {
  let total = 0;
  document.querySelectorAll('.item-row').forEach(row => {
    const qty = Number(row.querySelector('.item-qty').value) || 0;
    const rate = Number(row.querySelector('.item-rate').value) || 0;
    total += qty * rate;
  });
  document.getElementById('edit-total').textContent = total.toFixed(2);
}

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

  const bizName = document.getElementById('biz-name').value;
  const bizLogo = document.getElementById('biz-logo').value;
  const bizEmail = document.getElementById('biz-email').value;

  const btn = document.getElementById('save-and-link-btn');
  btn.disabled = true; btn.textContent = 'Saving & creating link...';

  try {
    // 1. Update the invoice in the database
    const updateRes = await fetch(`/api/invoice/${currentInvoiceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        client_name: clientName, client_email: clientEmail, items,
        business_name: bizName, business_logo: bizLogo, business_email: bizEmail
      })
    });
    if (!updateRes.ok) throw new Error('Failed to save changes');

    // 2. Create the payment link
    const linkRes = await fetch(`/api/invoice/${currentInvoiceId}/payment-link`, { method: 'POST' });
    const linkData = await linkRes.json();
    if (!linkRes.ok) throw new Error(linkData.error);

    document.getElementById('payment-result').innerHTML = `
      <div class="success-box">
        ✅ Invoice saved and payment link ready!
        <a href="${linkData.paymentLink}" target="_blank">${linkData.paymentLink}</a>
        <button onclick="navigator.clipboard.writeText('${linkData.paymentLink}')">Copy</button>
      </div>`;
      
    document.getElementById('view-invoice-btn').href = `/api/view/${currentInvoiceId}`;

  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Create Payment Link';
  }
});

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
