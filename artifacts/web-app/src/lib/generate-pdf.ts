import { jsPDF } from "jspdf";
import html2canvas from "html2canvas-pro";

/**
 * Render an off-screen DOM element into a formal A4 PDF (in-memory).
 *
 * The element is expected to contain one or more `[data-pdf-section]` children;
 * each is captured independently so that logical blocks (themes, summaries,
 * etc.) are never split across a page boundary unless a single block is taller
 * than a full page, in which case it is sliced cleanly.
 *
 * The result is a self-contained PDF with no browser-injected headers or
 * footers (URL / page title / date).
 */
async function buildReportPdf(root: HTMLElement): Promise<jsPDF> {
  const sections = Array.from(
    root.querySelectorAll<HTMLElement>("[data-pdf-section]"),
  );
  const targets = sections.length > 0 ? sections : [root];

  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const contentW = pageW - margin * 2;
  const usableH = pageH - margin * 2;
  const gap = 4;

  let cursorY = margin;

  for (const el of targets) {
    const canvas = await html2canvas(el, {
      // 1.5× keeps text/charts crisp in the PDF while cutting ~45% of the
      // pixels html2canvas must render and PNG-encode vs 2× — the dominant
      // cost when capturing tall sections and the recharts SVG.
      scale: 1.5,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
    });
    if (canvas.width === 0 || canvas.height === 0) continue;

    const imgW = contentW;
    const imgH = (canvas.height * imgW) / canvas.width;

    if (imgH <= usableH) {
      if (cursorY + imgH > pageH - margin) {
        pdf.addPage();
        cursorY = margin;
      }
      pdf.addImage(
        canvas.toDataURL("image/png"),
        "PNG",
        margin,
        cursorY,
        imgW,
        imgH,
        undefined,
        "FAST",
      );
      cursorY += imgH + gap;
    } else {
      // Section taller than one page — slice it across pages.
      const pxPerMm = canvas.width / contentW;
      const pagePxH = Math.floor(usableH * pxPerMm);
      let renderedPx = 0;

      if (cursorY > margin) {
        pdf.addPage();
        cursorY = margin;
      }

      while (renderedPx < canvas.height) {
        const slicePx = Math.min(pagePxH, canvas.height - renderedPx);
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = slicePx;
        const ctx = sliceCanvas.getContext("2d");
        if (!ctx) break;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
        ctx.drawImage(
          canvas,
          0,
          renderedPx,
          canvas.width,
          slicePx,
          0,
          0,
          canvas.width,
          slicePx,
        );
        const sliceH = slicePx / pxPerMm;
        pdf.addImage(
          sliceCanvas.toDataURL("image/png"),
          "PNG",
          margin,
          margin,
          contentW,
          sliceH,
          undefined,
          "FAST",
        );
        renderedPx += slicePx;
        cursorY = margin + sliceH + gap;
        if (renderedPx < canvas.height) {
          pdf.addPage();
          cursorY = margin;
        }
      }
    }
  }

  return pdf;
}

/**
 * Generate the report PDF exactly as the old direct-download path did, then —
 * instead of downloading it — open it in a new browser tab and pop the print
 * dialog for that PDF automatically.
 *
 * Why a new tab (and not a hidden iframe): printing a PDF from an off-screen
 * iframe is unreliable in Chromium — the PDF often fails to render in the
 * off-screen frame, so `contentWindow.print()` prints a BLANK page carrying the
 * parent page's header/footer. Loading the PDF as a real top-level document in
 * its own tab renders it in the browser's native PDF viewer, and jsPDF's
 * `autoPrint()` (a /Print open-action baked into the PDF) makes that viewer open
 * the print dialog on load. Printing a PDF — rather than an HTML page — carries
 * NO browser header/footer (date / title / URL) and prints exactly as drawn.
 *
 * The tab is opened synchronously, before the (async) PDF build, so it counts as
 * part of the user's click gesture and is not suppressed by the popup blocker.
 * If the popup is blocked anyway, we fall back to a direct download.
 */
export async function printReportPdf(
  root: HTMLElement,
  title: string,
): Promise<void> {
  // Open the viewer tab inside the click gesture (before any await) so the
  // popup blocker allows it; we navigate it to the PDF once it is built.
  const viewer = window.open("", "_blank");

  // Paint a loading screen into the blank tab immediately. Building the PDF
  // takes a few seconds, and an empty white tab looks like a failed load — this
  // gives instant feedback until we navigate the tab to the finished PDF.
  if (viewer) {
    viewer.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Preparing report…</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      html,body{height:100%;margin:0}
      body{display:flex;align-items:center;justify-content:center;background:#0b0f0e;color:#e7ece9;font-family:Helvetica,Arial,sans-serif}
      .wrap{text-align:center}
      .spinner{width:46px;height:46px;margin:0 auto 20px;border:4px solid rgba(255,255,255,.15);border-top-color:#0d9c79;border-radius:50%;animation:spin .8s linear infinite}
      .title{font-size:16px;font-weight:600;letter-spacing:.02em}
      .sub{margin-top:6px;font-size:13px;color:#9aa6a1}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body><div class="wrap"><div class="spinner"></div><div class="title">Generating your report…</div><div class="sub">This can take a few seconds. Please wait.</div></div></body></html>`);
    viewer.document.close();
  }

  let pdf: jsPDF;
  try {
    pdf = await buildReportPdf(root);
  } catch (err) {
    viewer?.close();
    throw err;
  }

  // Bake a /Print open-action into the PDF so the viewer auto-opens the dialog.
  pdf.autoPrint();
  const blob = pdf.output("blob");
  const blobUrl = URL.createObjectURL(blob);

  if (viewer) {
    viewer.location.href = blobUrl;
    // Keep the blob alive well past navigation, then release it.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } else {
    // Popup blocked — fall back to a normal download so the user still gets it.
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

/**
 * Build a filename in the form `YYYYMMDD <first 5 words of topic>.pdf`.
 * Used as the iframe/print-job title. Date is taken from the supplied value
 * (the report's completion date) formatted in the app's timezone; falls back
 * to today if absent.
 */
export function buildReportFilename(
  topic: string,
  date: string | Date | null | undefined,
): string {
  const d = date ? new Date(date) : new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  })
    .format(Number.isNaN(d.getTime()) ? new Date() : d)
    .replace(/-/g, "");

  const words = (topic ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim();

  return `${ymd}${words ? ` ${words}` : ""}.pdf`;
}
