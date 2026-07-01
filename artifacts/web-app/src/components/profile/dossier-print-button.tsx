import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Printer, Loader2 } from "lucide-react";
import { ProfilePdfDocument, type ProfilePdfData } from "./profile-pdf-document";
import { printReportPdf, buildReportFilename } from "@/lib/generate-pdf";

/**
 * Generates the formal profile dossier as a PDF and opens it in a new browser
 * tab (native PDF viewer) with the print dialog auto-armed — the SAME mechanism
 * the topic sentiment report uses (see report-view.tsx / generate-pdf.ts).
 *
 * The dossier document is kept mounted off-screen (position:fixed, far left —
 * NOT display:none) so its charts settle and html2canvas can capture them on
 * demand. The user reviews the PDF in its own tab before printing, instead of
 * the print dialog popping directly over the app.
 */
export function DossierPrintButton({ data }: { data: ProfilePdfData }) {
  const pdfRef = useRef<HTMLDivElement>(null);
  const [generating, setGenerating] = useState(false);

  const handlePrint = async () => {
    if (!pdfRef.current) return;
    setGenerating(true);
    try {
      await printReportPdf(pdfRef.current, buildReportFilename(data.title, new Date()));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <Button
        onClick={handlePrint}
        disabled={generating}
        className="bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        data-testid="button-print"
      >
        {generating ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Printer className="w-4 h-4 mr-2" />
        )}
        {generating ? "PREPARING…" : "PRINT"}
      </Button>

      {/* Off-screen formal dossier — the source captured into the PDF. Kept
          mounted (not display:none) so html2canvas can render the settled
          charts on demand. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          left: -10000,
          top: 0,
          width: 760,
          pointerEvents: "none",
        }}
      >
        <ProfilePdfDocument ref={pdfRef} data={data} />
      </div>
    </>
  );
}
