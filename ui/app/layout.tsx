import type { Metadata } from "next"
import "./globals.css"
import { Sidebar } from "@/components/sidebar"
import { Providers } from "@/components/providers"

export const metadata: Metadata = {
  title: "MemoryBench",
  description: "Benchmarking Framework for Memory Layer Providers",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg-primary">
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 ml-64 p-6 min-w-0 overflow-x-hidden">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  )
}
