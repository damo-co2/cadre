import { useEffect, useState } from "react";

/** True while the given media query matches; re-renders on change. SSR-safe (false until mounted). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The phone layout: sidebar as a drawer, computer as an overlay. Matches Tailwind's `max-md`. */
export const MOBILE_QUERY = "(max-width: 767px)";
