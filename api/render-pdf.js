import { createClient } from "@supabase/supabase-js";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function renderOfficePage(office, location) {
  const capacity = office.capacity;
  return `
    <div class="page">
      <div class="left">
        <h1>Private Office</h1>
        <div class="subtitle">${capacity} Person Office</div>
        <table>
          <tr><td>Office Number</td><td>#${office.office_number}</td></tr>
          <tr class="row-price"><td>Month-to-month term</td><td>$${office.month_to_month_price.toLocaleString()} + GST per month</td></tr>
          <tr class="row-price"><td>6-month term</td><td>$${office.six_month_price.toLocaleString()} + GST per month</td></tr>
          <tr class="row-price"><td>12-month term</td><td>$${office.twelve_month_price.toLocaleString()} + GST per month</td></tr>
          <tr class="row-price"><td>24-month term</td><td>$${office.twenty_four_month_price.toLocaleString()} + GST per month</td></tr>
          <tr><td>Deposit</td><td>${office.deposit_terms.split("\n").map(l => `<span class="deposit-line">${l}</span>`).join("")}</td></tr>
          <tr><td>Joining Fee</td><td>${office.joining_fee}</td></tr>
          <tr><td>Available from</td><td>${office.available_from}</td></tr>
        </table>
        <div class="location-footer">${location.name}</div>
      </div>
      <div class="right">
        <img src="${office.floorplan_image_url}" alt="Floorplan for office ${office.office_number}" />
      </div>
    </div>
  `;
}

function renderFullHTML(officesWithLocations) {
  const pages = officesWithLocations
    .map(({ office, location }) => renderOfficePage(office, location))
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Montserrat:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f1e8;
    --ink: #1a1a1a;
    --eucalypt: #9aa888;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--ink); font-family: 'Montserrat', sans-serif; font-weight: 400; -webkit-font-smoothing: antialiased; }
  .page {
    width: 297mm;
    height: 210mm;
    padding: 22mm 28mm;
    background: var(--bg);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20mm;
    align-items: start;
    page-break-after: always;
    overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  .left h1 { font-family: 'Cormorant Garamond', serif; font-weight: 400; font-size: 64px; line-height: 1; letter-spacing: -1px; margin-bottom: 8px; }
  .left .subtitle { font-size: 14px; font-weight: 400; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { border: 1px solid var(--ink); padding: 14px 16px; vertical-align: top; }
  td:first-child { width: 38%; }
  .row-price td { background: var(--eucalypt); }
  .deposit-line { display: block; }
  .deposit-line + .deposit-line { margin-top: 4px; }
  .location-footer { margin-top: 20px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--ink); opacity: 0.7; }
  .right { display: flex; align-items: flex-start; justify-content: center; padding-top: 20px; }
  .right img { width: 100%; height: auto; max-height: 160mm; object-fit: contain; }
  @page { size: A4 landscape; margin: 0; }
</style>
</head>
<body>${pages}</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { offices } = req.body;
  if (!Array.isArray(offices) || offices.length === 0) {
    return res.status(400).json({ error: "Missing 'offices' array in request body" });
  }

  let browser;
  try {
    const html = renderFullHTML(offices);

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    await browser.close();
    browser = null;

    const filename = `quote-${Date.now()}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from("offices")
      .upload(`quotes/${filename}`, pdfBuffer, {
        contentType: "application/pdf",
        cacheControl: "3600",
      });

    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabase.storage
      .from("offices")
      .getPublicUrl(`quotes/${filename}`);

    return res.status(200).json({
      pdf_url: urlData.publicUrl,
      filename,
      pages: offices.length,
    });
  } catch (err) {
    if (browser) await browser.close();
    console.error("render-pdf error:", err);
    return res.status(500).json({ error: err.message });
  }
}
