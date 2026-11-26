import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tokens = () => read('../app/design-tokens.css')
const value = (css: string, name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim()

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)
  assert.ok(rgb && rgb.length === 3)
  const [red, green, blue] = rgb.map(pair => {
    const channel = Number.parseInt(pair, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(first: string, second: string) {
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test('#1601: the app loads a shared Tailwind theme and exposes its existing Geist font', () => {
  assert.match(read('../app/globals.css'), /@import "\.\/design-tokens\.css";/)
  const css = tokens()
  assert.match(css, /@theme static\s*\{/)
  assert.equal(value(css, 'color-dazl-canvas'), '#FFFFF9')
  assert.equal(value(css, 'color-dazl-ink'), '#241E20')
  assert.equal(value(css, 'color-dazl-accent'), '#FE3C01')
  assert.equal(value(css, 'radius-dazl-control'), '5px')
  assert.equal(value(css, 'radius-dazl-card'), '8px')
  assert.equal(value(css, 'container-dazl-page'), '77.5rem')
  assert.equal(value(css, 'font-dazl-body'), 'var(--dazl-geist)')
  assert.equal(value(css, 'font-dazl-display'), 'var(--dazl-geist)')
  const layout = read('../app/layout.tsx')
  assert.match(layout, /Geist\(\{[^}]*variable: '--dazl-geist'/)
  assert.match(layout, /geist\.variable/)
})

test('#1601: body, accent text, and status token pairs meet WCAG AA contrast', () => {
  const css = tokens()
  for (const [ink, background] of [
    ['ink', 'canvas'], ['secondary', 'canvas'], ['secondary', 'surface'],
    ['accent-text', 'canvas'], ['surface', 'action'], ['held', 'held-tint'], ['blocked', 'blocked-tint'],
  ]) {
    const foreground = value(css, `color-dazl-${ink}`)
    const surface = value(css, `color-dazl-${background}`)
    assert.ok(foreground && surface, `${ink} and ${background} tokens exist`)
    assert.ok(contrast(foreground, surface) >= 4.5, `${ink} on ${background} meets 4.5:1`)
  }
})
