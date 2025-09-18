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
import * as yaml from 'yaml'

export function loadConfig(configPath) {
  const cfgText = fs.readFileSync(configPath, 'utf8')
  return yaml.parse(cfgText) || {}
}

export function toCsvRow(obj, headers) {
  return headers.map(h => JSON.stringify(obj[h] ?? '')).join(',')
}