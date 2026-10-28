// Files the agents can upload when testing upload fields: valid files, a wrong type and an oversized one.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

export const FIXTURES_DIR = join(DATA_DIR, 'fixtures');

const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 70 Td (pw-test document) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;
// A 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const FIXTURES: Record<string, { describe: string; make: () => Buffer | string }> = {
  'pw-test.pdf': { describe: 'small valid PDF', make: () => PDF },
  'pw-test.png': { describe: 'small valid PNG image', make: () => PNG },
  'pw-test.jpg': { describe: 'PNG data with a .jpg name', make: () => PNG },
  'pw-test.txt': { describe: 'plain text file', make: () => 'pw-test text file\n' },
  'pw-test.csv': { describe: 'CSV with a header and two rows', make: () => 'name,email\npw-test-a,pw-test-a@example.com\npw-test-b,pw-test-b@example.com\n' },
  'pw-test.docx': { describe: 'file with a .docx name (not a real Word file)', make: () => 'not really a docx' },
  'pw-test.exe': { describe: 'file with a .exe name, for wrong-type checks', make: () => 'MZ pw-test not a program' },
  'pw-test-empty.txt': { describe: 'empty file (0 bytes)', make: () => '' },
  'pw-test-large-30mb.pdf': { describe: '30 MB PDF, for size-limit checks', make: () => Buffer.concat([Buffer.from(PDF), Buffer.alloc(30 * 1024 * 1024, 32)]) },
};

export function ensureFixtures(): string {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, f] of Object.entries(FIXTURES)) {
    const file = join(FIXTURES_DIR, name);
    if (!existsSync(file)) writeFileSync(file, f.make());
  }
  return FIXTURES_DIR;
}

export const fixtureList = () => Object.entries(FIXTURES).map(([n, f]) => `${n} (${f.describe})`).join(', ');
