import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-gray-800">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">We couldn't find that</h1>
      <p className="mt-3 text-pretty text-sm text-gray-900">The restaurant or booking you're looking for doesn't exist or the link has expired.</p>
      <Link
        href="/"
        className="mt-8 inline-flex h-10 items-center rounded-md bg-gray-1000 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#383838]"
      >
        Discover restaurants
      </Link>
    </div>
  );
}
