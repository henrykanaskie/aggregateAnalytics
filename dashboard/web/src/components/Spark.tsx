import { useId } from "react";

/** The four-point spark on the Tailor button and in the questions: the one
 *  mark that says "this part shapes itself around you". */
export default function Spark({ size = 14 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="spark" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--cat-1)" />
          <stop offset="0.55" stopColor="var(--cat-2)" />
          <stop offset="1" stopColor="var(--cat-3)" />
        </linearGradient>
      </defs>
      <path d="M12 1.5c.6 4.9 2.6 8.4 9.5 10.5-6.9 2.1-8.9 5.6-9.5 10.5-.6-4.9-2.6-8.4-9.5-10.5C9.4 9.9 11.4 6.4 12 1.5Z" fill={`url(#sp${id})`} />
      <path d="M19.5 1.8c.2 1.6.9 2.7 3 3.4-2.1.7-2.8 1.8-3 3.4-.2-1.6-.9-2.7-3-3.4 2.1-.7 2.8-1.8 3-3.4Z" fill={`url(#sp${id})`} opacity=".75" />
    </svg>
  );
}
