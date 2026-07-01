import { Sidebar } from "./sidebar";

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <div className="no-print h-full">
        <Sidebar />
      </div>
      <main className="flex-1 overflow-y-auto relative">
        <div className="no-print absolute inset-0 pointer-events-none opacity-[0.015] z-50 mix-blend-overlay" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noiseFilter\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noiseFilter)\'/%3E%3C/svg%3E")' }}></div>
        <div
          className="no-print pointer-events-none fixed bottom-0 right-0 z-0"
          style={{
            width: "520px",
            height: "420px",
            backgroundImage: "none",
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "bottom right",
            opacity: 0.12,
            mixBlendMode: "screen",
          }}
        />
        {children}
      </main>
    </div>
  );
}