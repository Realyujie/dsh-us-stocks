import { useEffect, useRef, useState } from 'react'

/** Late reads, in ms, for layouts that settle after mount. */
const SETTLE_READS = [0, 120, 400]

/**
 * Rendered width in CSS pixels of the element the returned ref is attached to.
 *
 * A `viewBox` scales everything it contains, text included. That is right for
 * the candles and wrong for the labels: in a narrow conversation column the
 * chart renders 182px wide, a quarter of its 720-unit coordinate space, which
 * put the axis text at 2.5px. Knowing the real width lets the caller cancel
 * that scaling for text alone.
 *
 * Attach the ref to an HTML wrapper rather than the SVG itself: ResizeObserver
 * on SVG elements has a poor history across engines, and a plain element
 * sidesteps it. A window resize listener and a few delayed reads back the
 * observer up, since a tool card can be laid out well after it mounts.
 */
export function useRenderedWidth<T extends Element>(): [React.RefObject<T>, number | undefined] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)

  useEffect(() => {
    const node = ref.current
    if (node === null) return

    const read = (): void => {
      const next = node.getBoundingClientRect().width
      // Ignore a detached or collapsed card; a zero width would divide badly.
      if (next > 0) setWidth((current) => (current === next ? current : next))
    }

    const timers = SETTLE_READS.map((delay) => window.setTimeout(read, delay))
    window.addEventListener('resize', read)

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(read)
    observer?.observe(node)

    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      window.removeEventListener('resize', read)
      observer?.disconnect()
    }
  }, [])

  return [ref, width]
}
