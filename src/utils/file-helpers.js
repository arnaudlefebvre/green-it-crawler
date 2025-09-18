/*
 * Copyright 2025 Arnaud Lefebvre
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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