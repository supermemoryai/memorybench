"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const navigation = [
  {
    name: "Runs",
    href: "/runs",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z"
        />
      </svg>
    ),
  },
  {
    name: "Compare",
    href: "/compare",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
    ),
  },
  {
    name: "Leaderboard",
    href: "/leaderboard",
    icon: (
      <svg
        className="w-5 h-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0"
        />
      </svg>
    ),
  },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-bg-primary border-r border-[#333333] flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-[#333333]">
        <Link href="/">
          <span className="font-display text-2xl text-text-primary font-bold tracking-tight">
            memorybench
          </span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 space-y-1">
        {/* New Run Button */}
        <Link
          href="/runs/new"
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight text-white border border-transparent hover:border-white/30"
          style={{
            background: "linear-gradient(135deg, rgb(38, 123, 241) 40%, rgb(21, 70, 139) 100%)",
            boxShadow:
              "rgba(255, 255, 255, 0.25) 2px 2px 8px 0px inset, rgba(0, 0, 0, 0.15) -2px -2px 7px 0px inset",
          }}
        >
          <span className="text-lg leading-none">+</span>
          <span>New Run</span>
        </Link>

        {/* Compare Button */}
        <Link
          href="/compare/new"
          className="flex items-center justify-center px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight text-text-secondary hover:text-white border border-[#333333] hover:border-[#444444] bg-transparent"
        >
          Compare
        </Link>

        {/* Other nav items */}
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href === "/runs" && pathname?.startsWith("/runs") && pathname !== "/runs/new") ||
            (item.href === "/compare" &&
              pathname?.startsWith("/compare") &&
              pathname !== "/compare/new")

          return (
            <Link
              key={item.name}
              href={item.href}
              className={`
                flex items-center gap-3 px-3 py-1.5 rounded text-sm font-medium transition-all font-display tracking-tight
                ${
                  isActive
                    ? "bg-[#222222] text-text-primary"
                    : "text-text-secondary hover:bg-[#222222] hover:text-text-primary"
                }
              `}
            >
              {item.icon}
              {item.name}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
