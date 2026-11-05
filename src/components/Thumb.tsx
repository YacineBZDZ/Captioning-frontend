import { useState } from 'react';

/**
 * A thumbnail from an object URL, sized by CSS (no canvas). Files the
 * browser cannot decode show a neutral placeholder instead of a broken icon.
 */
export function Thumb({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="thumb-missing">No preview</span>;
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}
