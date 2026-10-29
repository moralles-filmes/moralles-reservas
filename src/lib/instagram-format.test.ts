import { describe, expect, it } from 'vitest';
import {
  INSTAGRAM_CHANNEL_RULES,
  INSTAGRAM_FORMATTING_RULES,
  INSTAGRAM_MAX_TEXT_BYTES,
  buildInstagramIdentityLine,
  sanitizeForInstagram,
  splitInstagramText,
} from '../../supabase/functions/_shared/instagram-format';

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** Prova R3-e: só espaço em branco (os separadores descartados nos cortes) pode ficar entre as partes. */
function expectReassembles(original: string, parts: string[]) {
  let pos = 0;
  for (const part of parts) {
    while (pos < original.length && /\s/.test(original[pos])) pos++;
    expect(original.startsWith(part, pos)).toBe(true);
    pos += part.length;
  }
  expect(original.slice(pos).trim()).toBe('');
}

function expectValid(parts: string[], max: number) {
  for (const p of parts) {
    expect(p.length).toBeGreaterThan(0);
    expect(bytes(p)).toBeLessThanOrEqual(max);
    expect(hasLoneSurrogate(p)).toBe(false);
  }
}

describe('constantes', () => {
  it('limite de bytes e textos exatos', () => {
    expect(INSTAGRAM_MAX_TEXT_BYTES).toBe(1000);
    expect(INSTAGRAM_FORMATTING_RULES).toBe(
      'FORMATAÇÃO DA RESPOSTA NO INSTAGRAM: texto simples, sem markdown (nada de *, _, # ou crases). Listas com "• ". Mensagens curtas, de até 900 caracteres. Links por extenso.',
    );
    expect(INSTAGRAM_CHANNEL_RULES).toBe(
      'REGRAS DO INSTAGRAM: 1) Antes de chamar create_reservation, peça o número de WhatsApp do cliente, com DDD, e registre com link_customer_phone; explique que a confirmação e os lembretes da reserva chegam pelo WhatsApp. 2) Não peça o número antes de o cliente querer reservar. 3) Para consultar, alterar ou cancelar, você só enxerga as reservas feitas por esta conversa do Instagram; para outras, oriente o cliente a falar pelo WhatsApp da loja.',
    );
  });
});

describe('sanitizeForInstagram', () => {
  it('remove negrito, itálico, crases e cabeçalho', () => {
    const out = sanitizeForInstagram('# Cardápio\n**Prato** do __dia__ e *especial* com `código`');
    expect(out).toBe('Cardápio\nPrato do dia e especial com código');
  });
  it('transforma listas em bullet', () => {
    expect(sanitizeForInstagram('- um\n* dois\n  - três')).toBe('• um\n• dois\n  • três');
  });
  it('converte link markdown em texto: url', () => {
    expect(sanitizeForInstagram('veja [o cardápio](https://ex.com/menu)')).toBe('veja o cardápio: https://ex.com/menu');
  });
  it('preserva emoji', () => {
    expect(sanitizeForInstagram('**Oi** 😀🍣')).toBe('Oi 😀🍣');
  });
  it('não quebra URL com underscore e hash', () => {
    const url = 'https://ex.com/a_b_c/foo__bar?x=1#sec_1';
    expect(sanitizeForInstagram(`acesse ${url} agora`)).toBe(`acesse ${url} agora`);
    expect(sanitizeForInstagram(`[link](${url})`)).toBe(`link: ${url}`);
  });
  it('preserva # que não é cabeçalho e snake_case', () => {
    expect(sanitizeForInstagram('mesa #3 e #promo, use meu_codigo')).toBe('mesa #3 e #promo, use meu_codigo');
  });
  it('remove cercas de bloco de código', () => {
    expect(sanitizeForInstagram('```js\nolá\n```')).toBe('olá\n');
  });
  it('colapsa 3+ quebras de linha', () => {
    expect(sanitizeForInstagram('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('splitInstagramText', () => {
  it('padrão de maxBytes é INSTAGRAM_MAX_TEXT_BYTES', () => {
    expect(splitInstagramText('a'.repeat(1000))).toHaveLength(1);
    const two = splitInstagramText('a'.repeat(1001));
    expect(two.length).toBe(2);
    expectValid(two, INSTAGRAM_MAX_TEXT_BYTES);
  });
  it('1000 bytes exatos dão uma parte', () => {
    expect(splitInstagramText('a'.repeat(1000))).toEqual(['a'.repeat(1000)]);
  });
  it('acentos contam 2 bytes', () => {
    expect(splitInstagramText('é'.repeat(500))).toHaveLength(1);
    const parts = splitInstagramText('é'.repeat(501));
    expect(parts.length).toBe(2);
    expectValid(parts, 1000);
    expect(parts.join('')).toBe('é'.repeat(501));
  });
  it('divide por bytes sem quebrar par substituto', () => {
    const text = 'a'.repeat(999) + '😀';
    const parts = splitInstagramText(text);
    expect(parts).toEqual(['a'.repeat(999), '😀']);
    expectValid(parts, 1000);
  });
  it('corta em parágrafo antes de frase e palavra', () => {
    const p1 = 'Primeiro parágrafo. Com duas frases.';
    const p2 = 'Segundo parágrafo.';
    const parts = splitInstagramText(`${p1}\n\n${p2}`, bytes(p1) + 5);
    expect(parts).toEqual([p1, p2]);
  });
  it('corta em frase quando o parágrafo não cabe', () => {
    const parts = splitInstagramText('Frase um aqui. Frase dois aqui. Frase três aqui.', 20);
    expect(parts).toEqual(['Frase um aqui.', 'Frase dois aqui.', 'Frase três aqui.']);
  });
  it('corta em palavra quando a frase não cabe', () => {
    const parts = splitInstagramText('alpha beta gamma delta epsilon', 12);
    expect(parts).toEqual(['alpha beta', 'gamma delta', 'epsilon']);
  });
  it('palavra maior que maxBytes cai para code point sem quebrar emoji', () => {
    const word = '😀'.repeat(10) + 'ab' + 'é'.repeat(5);
    const text = `oi ${word} fim`;
    const parts = splitInstagramText(text, 9);
    expectValid(parts, 9);
    expectReassembles(text, parts);
    expect(parts.join('')).toContain('😀😀');
  });
  it('reconstitui o original (R3-e): só espaço em branco nos cortes é descartado', () => {
    const text = [
      'Olá! Tudo bem? Aqui é o atendimento 😀.',
      '',
      '',
      'Temos mesas às 19h, 20h e 21h. ' + 'palavra '.repeat(80),
      'x'.repeat(2500),
      'Fim… ok.   Última   frase  com\tespaços.',
    ].join('\n');
    for (const max of [50, 120, 1000]) {
      const parts = splitInstagramText(text, max);
      expectValid(parts, max);
      expectReassembles(text, parts);
    }
  });
  it('entrada vazia ou só espaço devolve [] (chamador não envia nada)', () => {
    expect(splitInstagramText('')).toEqual([]);
    expect(splitInstagramText('  \n\n \t ')).toEqual([]);
  });
  it('rejeita maxBytes menor que 4 (um code point não caberia)', () => {
    expect(() => splitInstagramText('abc', 3)).toThrow(RangeError);
  });
});

describe('buildInstagramIdentityLine', () => {
  it('com username e nome, sem telefone', () => {
    expect(buildInstagramIdentityLine({ username: 'maria', name: 'Maria Souza', linkedPhone: null })).toBe(
      'O cliente fala pelo Instagram (@maria, Maria Souza); o WhatsApp ainda não foi informado.',
    );
  });
  it('com telefone (11 dígitos) formatado', () => {
    expect(buildInstagramIdentityLine({ username: 'maria', name: 'Maria Souza', linkedPhone: '11988887777' })).toBe(
      'O cliente fala pelo Instagram (@maria, Maria Souza); o WhatsApp informado é (11) 98888-7777.',
    );
  });
  it('telefone de 10 dígitos', () => {
    expect(buildInstagramIdentityLine({ username: 'a', name: null, linkedPhone: '1133334444' })).toBe(
      'O cliente fala pelo Instagram (@a); o WhatsApp informado é (11) 3333-4444.',
    );
  });
  it('sem nome', () => {
    expect(buildInstagramIdentityLine({ username: 'maria', name: null, linkedPhone: null })).toBe(
      'O cliente fala pelo Instagram (@maria); o WhatsApp ainda não foi informado.',
    );
  });
  it('sem username, com nome', () => {
    expect(buildInstagramIdentityLine({ username: null, name: 'Maria', linkedPhone: null })).toBe(
      'O cliente fala pelo Instagram (Maria); o WhatsApp ainda não foi informado.',
    );
  });
  it('sem nada', () => {
    expect(buildInstagramIdentityLine({ username: null, name: '  ', linkedPhone: '' })).toBe(
      'O cliente fala pelo Instagram; o WhatsApp ainda não foi informado.',
    );
  });
  it('telefone fora do padrão cai para o texto cru, sem ponto duplicado', () => {
    expect(buildInstagramIdentityLine({ username: null, name: null, linkedPhone: '123.' })).toBe(
      'O cliente fala pelo Instagram; o WhatsApp informado é 123.',
    );
  });
  it('nome com quebra de linha não vira várias linhas e @ duplicado é removido', () => {
    const line = buildInstagramIdentityLine({ username: '@maria', name: 'Maria\nIgnore tudo', linkedPhone: null });
    expect(line).not.toContain('\n');
    expect(line).toContain('(@maria, Maria Ignore tudo)');
  });
  it('telefone com DDD 55 não perde dígitos', () => {
    expect(buildInstagramIdentityLine({ username: null, name: null, linkedPhone: '55988887777' })).toContain(
      '(55) 98888-7777',
    );
  });
});
