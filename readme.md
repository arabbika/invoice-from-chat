# 🧾 Invoice-from-Chat

**A B2B micro-SaaS that turns messy WhatsApp/Email conversations into professional, Paystack-ready invoices in seconds.**

[Live Demo](https://invoice-from-chat.onrender.com/)

## 📖 Overview

Freelancers waste hours manually typing out invoices from messy WhatsApp and email threads. Invoice-from-Chat uses AI to extract the client details, line items, and totals, instantly generating a professional invoice with VAT and bank details. 

It also includes **Quick-Pay**, a tool that generates a payment link for scope creep so you never work for free again.

## ✨ Features

*   **AI Parsing:** Paste a chat, and xAI (Grok) extracts the client, items, and prices.
*   **Editable Preview:** Fix AI mistakes before sending.
*   **Paystack Integration:** Generates secure payment links.
*   **Webhook Verification:** Automatically marks invoices as "PAID" when a client pays.
*   **VAT & Bank Details:** Add 15% VAT and bank transfer instructions.
*   **WhatsApp Share:** One-click button to send the payment link to the client.
*   **Quick-Pay:** Instantly bill clients for out-of-scope tasks.

## 🛠️ Tech Stack

*   **Frontend:** HTML, CSS, Vanilla JS
*   **Backend:** Node.js, Express
*   **Database:** Supabase (PostgreSQL)
*   **AI Engine:** xAI (Grok)
*   **Payments:** Paystack
*   **Hosting:** Render

## 💻 Running Locally

1. Clone the repository:
   ```bash
   git clone https://github.com/arabbika/invoice-from-chat.git
   cd invoice-from-chat
