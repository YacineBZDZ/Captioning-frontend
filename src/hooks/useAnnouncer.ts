import { useCallback, useRef, useState } from 'react';

export interface Announcement {
  id: number;
  text: string;
}

/** Messages for the polite live region; keeps only the most recent few. */
export function useAnnouncer(keep = 3) {
  const [messages, setMessages] = useState<Announcement[]>([]);
  const next = useRef(0);
  const announce = useCallback(
    (text: string) => setMessages((m) => [...m, { id: ++next.current, text }].slice(-keep)),
    [keep],
  );
  return { messages, announce };
}
