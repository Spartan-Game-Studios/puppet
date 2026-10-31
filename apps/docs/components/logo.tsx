/* The pixel wordmark from the Steam library logo. The dark variant swaps the
   black wordmark for paper so it reads on ink; the orange V tile stays. */
export function Logo({ className = 'h-6' }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="VPuppet" className={`${className} w-auto dark:hidden`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-dark.png" alt="VPuppet" className={`${className} w-auto hidden dark:block`} />
    </>
  );
}
