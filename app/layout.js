import "./globals.css";

export const metadata = {
  title: "Decomposition scenario runner",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
