let currentInvoiceId = null;

function switchTab(tabId, event) {
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  
  document.getElementById(tabId + '-tab').style.display = 'block';
  if (event) event.target.classList.add('active');
}

function showToast(message) {
  const toast = document.getElementById('toast-container');
  document.getElementById('toast-message').textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

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
  document.getElementById('chat').value = `Client: Hey! I need a landing page redesign and a new logo by Friday.\nMe: Sure — R500 for the landing page and R200 for the logo.\nClient: Deal. Send the invoice to john@acme.com`;
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
    showToast('Invoice generated!');
    
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
  row.innerHTML = `
    <input type="text" class="item-desc" placeholder="Description" value="${escapeHTML(desc)}">
    <input type="number" class="item-qty" placeholder="Qty" value="${qty}" min="1" oninput="updateTotal()">
    <input type="number" class="item-rate" placeholder="Rate" value="${rate}" min="0" oninput="updateTotal()">
    <button onclick="this.parentElement.remove(); updateTotal();" class="delete-btn">×</button>
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
    document.getElementById('vat-display').style.display = 'flex';
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
  if (!clientEmail) return showToast('Client email is required.');

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
    client_name: clientName, client_email: clientEmail, items,
    business_name: document.getElementById('biz-name').value,
    business_logo: document.getElementById('biz-logo').value,
    business_email: document.getElementById('biz-email').value,
    bank_details: document.getElementById('bank-details').value,
    vat_amount: vatAmount, due_days: document.getElementById('edit-due-days').value
  };

  const btn = document.getElementById('save-and-link-btn');
  btn.disabled = true; btn.textContent = 'Saving...';

  try {
    await fetch(`/api/invoice/${currentInvoiceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const linkRes = await fetch(`/api/invoice/${currentInvoiceId}/payment-link`, { method: 'POST' });
    const linkData = await linkRes.json();
    if (!linkRes.ok) throw new Error(linkData.error);

    document.getElementById('payment-result').innerHTML = `
      <div class="success-box">
        ✅ Invoice saved and payment link ready!
        <div class="action-buttons">
          <a href="${linkData.paymentLink}" target="_blank" class="btn-primary" style="padding: 10px 16px; font-size: 14px;">Pay Link</a>
          <button onclick="sendWhatsApp('${linkData.paymentLink}')" class="btn-whatsapp">Send on WhatsApp</button>
        </div>
      </div>`;
    document.getElementById('view-invoice-btn').href = `/api/view/${currentInvoiceId}`;
    showToast('Payment link created!');
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save & Create Payment Link';
  }
});

document.getElementById('qp-generate-btn').addEventListener('click', async () => {
  const task = document.getElementById('qp-task').value.trim();
  const amount = document.getElementById('qp-amount').value;
  const clientMessage = document.getElementById('qp-message').value.trim();
  const errorEl = document.getElementById('qp-error');
  const resultDiv = document.getElementById('qp-result');
  
  errorEl.textContent = '';
  resultDiv.style.display = 'none';

  if (!task || !amount) { errorEl.textContent = 'Please provide a task and an amount.'; return; }

  const btn = document.getElementById('qp-generate-btn');
  btn.disabled = true; btn.textContent = 'Generating...';

  try {
    const res = await fetch('/api/quickpay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, amount, clientMessage })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate link');

    const finalMessage = `${data.politeMessage}\n\nPay here: ${data.paymentLink}`;
    document.getElementById('qp-output-msg').value = finalMessage;
    document.getElementById('qp-payment-link').href = data.paymentLink;
    resultDiv.style.display = 'block';
    showToast('Quick-Pay link generated!');
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Generate Quick-Pay Link';
  }
});

function copyQuickPayMessage() {
  const text = document.getElementById('qp-output-msg').value;
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!');
}

function sendWhatsApp(link) {
  const bizName = document.getElementById('biz-name').value || 'your business';
  const clientName = document.getElementById('edit-client-name').value;
  const text = `Hi ${clientName}, here is the invoice from ${bizName}. You can view and pay it here: ${link}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
