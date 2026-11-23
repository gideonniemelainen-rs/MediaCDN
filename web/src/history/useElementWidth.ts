import { useEffect, useRef, useState, type RefObject } from 'react'

/** The rendered width of an element in px (0 until it is measured), kept current as it resizes. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
