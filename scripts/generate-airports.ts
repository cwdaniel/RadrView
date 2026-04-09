// Downloads OurAirports data and generates airports.json.
// Run: npx tsx scripts/generate-airports.ts

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function main() {
  console.log('Fetching OurAirports data...');
  const resp = await fetch(CSV_URL);
  const text = await resp.text();
  const lines = text.split('\n');
  const header = parseCSVLine(lines[0]).map(h => h.trim());

  const identIdx = header.indexOf('ident');
  const typeIdx = header.indexOf('type');
  const nameIdx = header.indexOf('name');
  const latIdx = header.indexOf('latitude_deg');
  const lonIdx = header.indexOf('longitude_deg');

  const airports: Record<string, { name: string; lat: number; lon: number }> = {};
  let count = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCSVLine(line);

    const ident = (cols[identIdx] || '').trim();
    const type = (cols[typeIdx] || '').trim();
    const lat = parseFloat((cols[latIdx] || '').trim());
    const lon = parseFloat((cols[lonIdx] || '').trim());
    const name = (cols[nameIdx] || '').trim();

    if (ident.length !== 4) continue;
    if (type === 'heliport' || type === 'closed') continue;
    if (isNaN(lat) || isNaN(lon)) continue;

    airports[ident] = { name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
    count++;
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, '..', 'data', 'airports.json');
  writeFileSync(outPath, JSON.stringify(airports, null, 2));
  console.log(`Wrote ${count} airports to ${outPath}`);
}

main().catch(console.error);
