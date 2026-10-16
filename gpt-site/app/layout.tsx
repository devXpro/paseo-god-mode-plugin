import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {title: "paseo-remote", description: "Private Paseo remote tools"};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
