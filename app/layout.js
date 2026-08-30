import './globals.css';

export const metadata = {
  title: 'POS System',
  description: 'A general-purpose point-of-sale system with a WebMCP agent interface.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
