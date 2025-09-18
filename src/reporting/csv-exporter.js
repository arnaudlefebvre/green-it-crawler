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
import { toCsvRow } from '../utils/config-loader.js'

export function appendToHistory(historyPath, result) {
  fs.appendFileSync(historyPath, JSON.stringify(result) + '\n')
}

export function appendToCsv(csvPath, result) {
  const headers = Object.keys(result)
  if (!fs.existsSync(csvPath) || fs.readFileSync(csvPath, 'utf8').trim() === '') {
    fs.writeFileSync(csvPath, headers.join(',') + '\n')
  }
  fs.appendFileSync(csvPath, toCsvRow(result, headers) + '\n')
}