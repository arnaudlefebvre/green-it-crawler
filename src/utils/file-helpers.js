import fs from 'fs'
import path from 'path'

export function ensureDir(p) {
  if (!fs.existsSync(p))
    fs.mkdirSync(p, { recursive: true })
}

export function nowIso() {
  return new Date().toISOString()
}

export function safeName(s) {
  return (s || '').toString().replace(/\W+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
}

export function prettyBytes(n) {
  if (!n) return '0 B'
  const k = 1024
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.max(0, Math.floor(Math.log(n) / Math.log(k))))
  return `${(n/Math.pow(k,i)).toFixed(2)} ${u[i]}`
}

export function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

export function round4(x) {
  return Math.round((x + Number.EPSILON) * 10000) / 10000
}