let currentInvoiceId = null;

// Load saved settings when page opens
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('biz-name').value = localStorage.getItem('bizName') || '';
  document.getElementById('biz-email').value = localStorage.getItem('bizEmail') || '';
  document.getElementById('biz-logo').value = localStorage.getItem('bizLogo') || '';
});

// Save settings as the user types
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
  btn.disabled = true; btn.textContent = 'Parsing...';

  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to parse');

    currentInvoiceId = data.invoiceId;
    renderInvoice(data.invoice);
    document.getElementById('input-section').style.display = 'none';
    document.getElementById('result-section').style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Generate Invoice';
  }
});

function renderInvoice(inv) {
  const rows = inv.items.map(i => `
    <tr>
      <td>${escapeHTML(i.description)}</td>
      <td class="num">${i.quantity}</td>
      <td class="num">${i.rate.toFixed(2)}</td>
      <td class="num">${(i.quantity * i.rate).toFixed(2)}</td>
    </tr>`).join('');

  document.getElementById('invoice-preview').innerHTML = `
    <div class="invoice-card">
      <div class="invoice-header">
        <div>
          <div class="label">BILL TO</div>
          <div class="value">${escapeHTML(inv.client.name)}</div>
          ${inv.client.email ? `<div class="sub">${escapeHTML(inv.client.email)}</div>` : ''}
        </div>
        <div class="total-big">${inv.currency} ${inv.subtotal.toFixed(2)}</div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${inv.notes ? `<div class="notes">${escapeHTML(inv.notes)}</div>` : ''}
    </div>`;

  // Add business details to the URL so the printable page can use them
  const name = encodeURIComponent(document.getElementById('biz-name').value || 'Your Business');
  const logo = encodeURIComponent(document.getElementById('biz-logo').value || '');
  const email = encodeURIComponent(document.getElementById('biz-email').value || '');
  document.getElementById('view-invoice-btn').href = `/invoice/${inv.invoiceId}?name=${name}&logo=${logo}&email=${email}`;
}

document.getElementById('create-link-btn').addEventListener('click', async () => {
  if (!currentInvoiceId) return;
  const btn = document.getElementById('create-link-btn');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const res = await fetch(`/api/invoice/${currentInvoiceId}/payment-link`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('payment-result').innerHTML = `
      <div class="success-box">
        ✅ Payment link ready!
        <a href="${data.paymentLink}" target="_blank">${data.paymentLink}</a>
        <button onclick="navigator.clipboard.writeText('${data.paymentLink}')">Copy</button>
      </div>`;
  } catch (err) {
    document.getElementById('payment-result').innerHTML = `<div class="error">${err.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Create Payment Link';
  }
});

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}