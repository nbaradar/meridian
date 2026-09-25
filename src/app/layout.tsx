import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Meridian",
  description: "A self-hosted personal financial dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
