import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = resolve(process.cwd(), 'src/index.css');
const css = readFileSync(CSS_PATH, 'utf8');

type RGB = [number, number, number];
type Tokens = Record<string, string>;

/** Extrai o corpo de um bloco cujo seletor é exatamente `selector {` (ignora @media interno). */
function extractBlock(source: string, selector: string): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Bloco não encontrado: ${selector}`);
  let i = source.indexOf('{', start) + 1;
  let depth = 1;
  const bodyStart = i;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return source.slice(bodyStart, i - 1);
}

/** Remove blocos @media aninhados do corpo (para não capturar --glass-blur: 16px). */
function stripMediaBlocks(body: string): string {
  let result = '';
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf('@media', i);
    if (at === -1) {
      result += body.slice(i);
      break;
    }
    result += body.slice(i, at);
    let depth = 0;
    let j = at;
    let opened = false;
    while (j < body.length) {
      const ch = body[j];
      if (ch === '{') {
        depth += 1;
        opened = true;
      } else if (ch === '}') {
        depth -= 1;
        if (opened && depth === 0) {
          j += 1;
          break;
        }
      }
      j += 1;
    }
    i = j;
  }
  return result;
}

const TOKEN_RE = /(--[\w-]+)\s*:\s*([^;]+);/g;

function parseTokens(body: string): Tokens {
  const clean = stripMediaBlocks(body).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens: Tokens = {};
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(clean)) !== null) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

const dayBody = extractBlock(css, ':root, .theme-admin');
const nightBody = extractBlock(css, '.dark, .dark .theme-admin');
const day = parseTokens(dayBody);
const night = parseTokens(nightBody);

/** 'H S% L%' → RGB [0..255]. */
function hslToRgb(value: string): RGB {
  const m = value
    .replace(/\//g, ' ')
    .trim()
    .match(/(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%/);
  if (!m) throw new Error(`HSL inválido: ${value}`);
  const h = ((parseFloat(m[1]) % 360) + 360) % 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m0 = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const round = (n: number) => Math.round((n + m0) * 255);
  return [round(r), round(g), round(b)];
}

/** Hex → RGB. */
function hexToRgb(hex: string): RGB {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: RGB): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenRgb(tokens: Tokens, name: string): RGB {
  const value = tokens[name];
  if (!value) throw new Error(`Token ausente: ${name}`);
  return hslToRgb(value);
}

function maxChannelDiff(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

const PROJECT_TOKENS = [
  '--background', '--foreground', '--card', '--card-foreground', '--popover',
  '--popover-foreground', '--primary', '--primary-foreground', '--secondary',
  '--secondary-foreground', '--muted', '--muted-foreground', '--tertiary-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--border', '--input', '--ring', '--radius', '--gold', '--gold-foreground',
  '--gold-ink', '--info', '--info-foreground', '--success', '--success-foreground',
  '--warning', '--warning-foreground', '--surface-elevated', '--sidebar-background',
  '--sidebar-foreground', '--sidebar-primary', '--sidebar-primary-foreground',
  '--sidebar-accent', '--sidebar-accent-foreground', '--sidebar-border', '--sidebar-ring',
  '--status-free', '--status-reserved', '--status-arriving', '--status-seated',
  '--status-late', '--status-pending', '--glass-tint', '--glass-alpha',
  '--glass-strong-alpha', '--glass-edge', '--glass-edge-alpha', '--glass-highlight',
  '--glass-highlight-alpha', '--glass-blur', '--shadow-color',
  '--chart-reserva', '--chart-whatsapp', '--chart-trigger-rating', '--chart-fila',
  '--chart-used', '--chart-trigger-frequency', '--chart-passante',
  '--chart-trigger-manual', '--chart-trigger-other', '--chart-geral', '--chart-email',
  '--chart-issued', '--chart-trigger-birthday',
];

// Só os valores marcados com † na spec; os derivados podem mudar para passar no contraste.
interface Spec { name: string; night: string | null; day: string | null }
const SPEC: Spec[] = [
  { name: '--background', night: '#0B0D11', day: '#EDEFF2' },
  { name: '--foreground', night: '#F3F1EC', day: '#111318' },
  { name: '--card', night: '#14161B', day: '#FFFFFF' },
  { name: '--card-foreground', night: '#F3F1EC', day: '#111318' },
  { name: '--popover-foreground', night: '#F3F1EC', day: '#111318' },
  { name: '--secondary-foreground', night: '#F3F1EC', day: '#111318' },
  { name: '--accent-foreground', night: '#F3F1EC', day: '#111318' },
  { name: '--primary', night: '#E2C48A', day: '#111318' },
  { name: '--primary-foreground', night: '#1A1408', day: '#F6F4EF' },
  { name: '--muted-foreground', night: '#B0ADA7', day: '#4F545C' },
  { name: '--tertiary-foreground', night: '#8E8B86', day: '#5E636B' },
  { name: '--ring', night: '#E2C48A', day: '#9A7434' },
  { name: '--gold', night: '#E2C48A', day: '#9A7434' },
  { name: '--gold-ink', night: '#E8CC93', day: '#7A5A20' },
  { name: '--sidebar-primary', night: '#E2C48A', day: '#9A7434' },
  { name: '--sidebar-ring', night: '#E2C48A', day: '#9A7434' },
  { name: '--sidebar-foreground', night: '#B0ADA7', day: '#4F545C' },
  { name: '--sidebar-accent-foreground', night: '#E8CC93', day: '#7A5A20' },
  { name: '--sidebar-background', night: '#08090C', day: null },
  { name: '--status-free', night: null, day: '#4F545C' },
  { name: '--status-reserved', night: '#E2C48A', day: '#7A5A20' },
  { name: '--status-arriving', night: '#9EC1FF', day: '#2F62B8' },
  { name: '--status-seated', night: '#7ED8B0', day: '#1F7A56' },
  { name: '--status-late', night: '#FF9478', day: '#B4442A' },
  { name: '--status-pending', night: null, day: '#4F545C' },
];

describe('theme-tokens (Dia e Noite)', () => {
  it('os dois grupos de escopo existem e definem os mesmos tokens', () => {
    const dayNames = Object.keys(day).sort();
    const nightNames = Object.keys(night).sort();
    expect(dayNames).toEqual(nightNames);
    for (const name of PROJECT_TOKENS) {
      expect(dayNames, `Dia sem ${name}`).toContain(name);
      expect(nightNames, `Noite sem ${name}`).toContain(name);
    }
  });

  it('valores da spec batem (tolerância 2 por canal RGB)', () => {
    for (const spec of SPEC) {
      if (spec.day) {
        const dDiff = maxChannelDiff(tokenRgb(day, spec.name), hexToRgb(spec.day));
        expect(dDiff, `Dia ${spec.name} = ${spec.day}`).toBeLessThanOrEqual(2);
      }
      if (spec.night) {
        const nDiff = maxChannelDiff(tokenRgb(night, spec.name), hexToRgb(spec.night));
        expect(nDiff, `Noite ${spec.name} = ${spec.night}`).toBeLessThanOrEqual(2);
      }
    }
  });

  const AA_PAIRS: Array<[string, string]> = [
    ['--foreground', '--background'],
    ['--foreground', '--card'],
    ['--foreground', '--popover'],
    ['--muted-foreground', '--background'],
    ['--muted-foreground', '--card'],
    ['--muted-foreground', '--muted'],
    ['--tertiary-foreground', '--background'],
    ['--tertiary-foreground', '--card'],
    ['--gold-ink', '--background'],
    ['--gold-ink', '--card'],
    ['--primary-foreground', '--primary'],
    ['--destructive-foreground', '--destructive'],
    ['--success-foreground', '--success'],
    ['--info-foreground', '--info'],
    ['--warning-foreground', '--warning'],
    ['--sidebar-foreground', '--sidebar-background'],
    ['--sidebar-accent-foreground', '--sidebar-accent'],
    ['--status-reserved', '--card'],
    ['--status-arriving', '--card'],
    ['--status-seated', '--card'],
    ['--status-late', '--card'],
    ['--status-pending', '--card'],
  ];

  it('contraste AA de texto >= 4.5 nos dois temas', () => {
    for (const theme of [['Dia', day] as const, ['Noite', night] as const]) {
      const [label, tokens] = theme;
      for (const [fg, bg] of AA_PAIRS) {
        const ratio = contrastRatio(tokenRgb(tokens, fg), tokenRgb(tokens, bg));
        expect(ratio, `${label}: ${fg} sobre ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('contraste de indicador >= 3 nos dois temas', () => {
    const pairs: Array<[string, string]> = [
      ['--status-free', '--card'],
      ['--gold-foreground', '--gold'],
    ];
    for (const theme of [['Dia', day] as const, ['Noite', night] as const]) {
      const [label, tokens] = theme;
      for (const [fg, bg] of pairs) {
        const ratio = contrastRatio(tokenRgb(tokens, fg), tokenRgb(tokens, bg));
        expect(ratio, `${label}: ${fg} sobre ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
