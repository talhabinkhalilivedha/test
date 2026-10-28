// CSV / Excel: importing a QA's test cases, the sample template, and exporting run results.
import ExcelJS from 'exceljs';
import type { CaseInput } from '../db.js';
import type { PageConfig, TestResult } from '../types.js';

export const CASE_COLUMNS = ['Test ID', 'Title', 'Category', 'Priority', 'Preconditions', 'Steps', 'Expected Result', 'Test Data'] as const;

// Header spellings people use, mapped to our fields.
const ALIASES: Record<string, keyof CaseInput> = {
  'test id': 'ref', 'id': 'ref', 'tc id': 'ref', 'test case id': 'ref', 'case id': 'ref',
  'title': 'title', 'test case': 'title', 'name': 'title', 'summary': 'title', 'scenario': 'title', 'test scenario': 'title', 'description': 'title',
  'category': 'category', 'type': 'category', 'module': 'category',
  'priority': 'priority',
  'preconditions': 'preconditions', 'precondition': 'preconditions', 'pre-conditions': 'preconditions', 'prerequisites': 'preconditions',
  'steps': 'steps', 'test steps': 'steps', 'steps to execute': 'steps', 'actions': 'steps',
  'expected result': 'expected', 'expected results': 'expected', 'expected': 'expected', 'expected outcome': 'expected',
  'test data': 'testData', 'data': 'testData', 'input data': 'testData',
};

export interface ImportResult {
  cases: CaseInput[];
  skipped: number;
  warnings: string[];
}

export async function parseCases(fileName: string, data: Buffer): Promise<ImportResult> {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName)) {
    const sheet = workbook.addWorksheet('cases');
    for (const row of parseCsv(data.toString('utf8').replace(/^﻿/, ''))) sheet.addRow(row);
  } else {
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return { cases: [], skipped: 0, warnings: ['The file has no sheets'] };

  // The header row is the first row that names a title and steps or expected-result column.
  let headerRow = 0;
  const fields: Record<number, keyof CaseInput> = {};
  for (let r = 1; r <= Math.min(sheet.rowCount, 10) && !headerRow; r++) {
    const found: Record<number, keyof CaseInput> = {};
    sheet.getRow(r).eachCell((cell, col) => {
      const field = ALIASES[cellText(cell.value).toLowerCase().replace(/[*:]/g, '').trim()];
      if (field) found[col] = field;
    });
    const named = Object.values(found);
    if (named.includes('title') && (named.includes('steps') || named.includes('expected'))) {
      headerRow = r;
      Object.assign(fields, found);
    }
  }
  if (!headerRow) {
    return { cases: [], skipped: 0, warnings: [`No header row found. The file needs at least the columns "Title" and "Steps" or "Expected Result" (see the sample file).`] };
  }

  const cases: CaseInput[] = [];
  let skipped = 0;
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const c: Partial<Record<keyof CaseInput, string>> = {};
    sheet.getRow(r).eachCell((cell, col) => {
      if (fields[col]) c[fields[col]] = cellText(cell.value).trim();
    });
    if (!c.title && !c.steps) continue;
    if (!c.title || (!c.steps && !c.expected)) {
      skipped++;
      continue;
    }
    const priority = (c.priority ?? '').toLowerCase();
    cases.push({
      source: 'upload',
      ref: c.ref || `UP-${String(cases.length + 1).padStart(3, '0')}`,
      title: c.title,
      category: c.category || 'functional',
      priority: /high|critical|p0|p1|1/.test(priority) ? 'high' : /low|p3|p4|3|4/.test(priority) ? 'low' : 'medium',
      preconditions: c.preconditions ?? '',
      steps: c.steps ?? '',
      expected: c.expected ?? '',
      testData: c.testData ?? '',
    });
  }
  const warnings = skipped ? [`${skipped} row(s) skipped: they need a title and steps or an expected result`] : [];
  return { cases, skipped, warnings };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

/** RFC 4180 CSV: quoted fields may contain commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const delimiter = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvField = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

const SAMPLE_ROWS = [
  ['TC-001', 'Login with valid credentials', 'functional', 'High', 'A registered user exists',
    '1. Enter a valid email\n2. Enter the password\n3. Click "Sign in"', 'The dashboard opens and shows the user\'s name', 'user@example.com'],
  ['TC-002', 'Required field validation on the contact form', 'validation', 'Medium', '',
    '1. Leave "Email" empty\n2. Click "Send"', 'An error "Email is required" is shown and nothing is sent', ''],
  ['TC-003', 'Search returns matching results', 'search', 'Medium', 'At least one product exists',
    '1. Type "shirt" in the search box\n2. Press Enter', 'Only products containing "shirt" are listed', 'shirt'],
];

export async function sampleFile(format: 'csv' | 'xlsx'): Promise<Buffer> {
  if (format === 'csv') return Buffer.from(toCsv([[...CASE_COLUMNS], ...SAMPLE_ROWS]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Test cases');
  sheet.columns = CASE_COLUMNS.map((h) => ({ header: h, key: h, width: h === 'Steps' || h === 'Expected Result' ? 45 : h === 'Title' ? 40 : 16 }));
  SAMPLE_ROWS.forEach((r) => sheet.addRow(r));
  styleSheet(sheet);
  const help = workbook.addWorksheet('How to fill this in');
  help.columns = [{ width: 22 }, { width: 90 }];
  [
    ['Column', 'Meaning'],
    ['Test ID', 'Optional. Your own id; shown in reports.'],
    ['Title', 'Required. What the test checks.'],
    ['Category', 'Optional: functional, validation, negative, search, navigation, uploads, content.'],
    ['Priority', 'Optional: High, Medium or Low.'],
    ['Preconditions', 'Optional. What must be true before the test starts.'],
    ['Steps', 'Required (or Expected Result). Numbered steps, one per line, using the labels shown on the page.'],
    ['Expected Result', 'What should happen. Be concrete: exact messages, what appears or changes.'],
    ['Test Data', 'Optional. Values to use. Write {{uid}} where a value must be unique on every run.'],
    ['', 'Upload one file per page: every row in the file is a test case for that page.'],
  ].forEach((r) => help.addRow(r));
  help.getRow(1).font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.eachRow((row) => row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true }; }));
}

const RESULT_COLUMNS = ['Page', 'Test ID', 'Title', 'Category', 'How', 'Status', 'Classification', 'Steps performed', 'Expected', 'Actual',
  'Bug title', 'Severity', 'Duration (s)', 'Cost (USD)', 'Model'];

function resultRows(results: TestResult[], pages: PageConfig[]): unknown[][] {
  const pageName = (id: string) => { const p = pages.find((x) => x.id === id); return p ? p.name || p.url : ''; };
  const how = { ai: 'AI agent', replay: 'Replayed (no AI)', check: 'Automatic check' };
  return results.map((r) => [
    pageName(r.pageId), r.ref, r.title, r.category, how[r.mode], r.status, r.classification ?? '',
    r.steps.filter((s) => s.ok || r.status !== 'passed').map((s, i) => `${i + 1}. ${s.text}${s.ok ? '' : ` (failed: ${s.error ?? ''})`}`).join('\n'),
    r.expected, r.actual, r.bug?.title ?? '', r.bug?.severity ?? '', (r.durationMs / 1000).toFixed(1), r.costUsd.toFixed(4), r.model,
  ]);
}

export async function exportResults(format: 'csv' | 'xlsx', results: TestResult[], pages: PageConfig[]): Promise<Buffer> {
  const rows = resultRows(results, pages);
  if (format === 'csv') return Buffer.from(toCsv([RESULT_COLUMNS, ...rows]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Results');
  sheet.columns = RESULT_COLUMNS.map((h) => ({ header: h, width: ['Steps performed', 'Expected', 'Actual'].includes(h) ? 50 : h === 'Title' ? 40 : 14 }));
  rows.forEach((r) => sheet.addRow(r));
  styleSheet(sheet);
  const colors: Record<string, string> = { passed: 'FFDCFCE7', failed: 'FFFEE2E2', blocked: 'FFFEF3C7', skipped: 'FFF1F5F9' };
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const status = String(row.getCell(6).value);
    if (colors[status]) row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[status] } };
  });
  const bugs = workbook.addWorksheet('Bugs');
  bugs.columns = ['Page', 'Test ID', 'Bug title', 'Severity', 'Steps to reproduce', 'Expected', 'Actual'].map((h) => ({ header: h, width: h.startsWith('Steps') ? 60 : 30 }));
  for (const r of results.filter((x) => x.bug && x.status === 'failed')) {
    const page = pages.find((p) => p.id === r.pageId);
    bugs.addRow([page?.name || page?.url || '', r.ref, r.bug!.title, r.bug!.severity,
      r.bug!.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n'), r.bug!.expected, r.bug!.actual]);
  }
  styleSheet(bugs);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
