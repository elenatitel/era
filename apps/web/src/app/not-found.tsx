import Link from 'next/link';
import { Wordmark } from '@/components/wordmark';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
      <Wordmark tagline />
      <p className="font-display text-7xl leading-none font-medium text-ink italic">404</p>
      <Link href="/dashboard" className="text-sm text-accent hover:underline">
        ← Dashboard
      </Link>
    </div>
  );
}
