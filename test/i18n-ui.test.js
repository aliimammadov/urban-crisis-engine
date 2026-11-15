import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dict } from '../src/i18n.js';

const PUBLIC = new URL('../public/', import.meta.url);
const uiFiles = readdirSync(PUBLIC).filter((f) => /\.(html|js)$/.test(f));

test('Azerbaijani and English are complete and have exactly the same keys (Russian too)', () => {
  const az = Object.keys(dict.az).sort();
  assert.deepEqual(Object.keys(dict.en).sort(), az);
  assert.deepEqual(Object.keys(dict.ru).sort(), az);
  for (const lang of ['az', 'en', 'ru']) {
    for (const [k, v] of Object.entries(dict[lang])) assert.ok(typeof v === 'string' && v.trim(), `${lang}:${k} is empty`);
  }
});

test('English strings are really English and Azerbaijani ones really differ (no copy-paste placeholders)', () => {
  const azSpecific = Object.entries(dict.en).filter(([, v]) => /[əƏıİşŞğĞ]/.test(v));
  assert.deepEqual(azSpecific, [], 'English dictionary contains Azerbaijani-only letters');
  const cyr = Object.entries(dict.en).filter(([, v]) => /[А-Яа-яЁё]/.test(v));
  assert.deepEqual(cyr, [], 'English dictionary contains Cyrillic');
});

test('no UI file hardcodes Azerbaijani text: everything user-visible comes from the dictionary', () => {
  for (const f of uiFiles) {
    const src = readFileSync(new URL(f, PUBLIC), 'utf8');
    const m = src.match(/[əƏıİşŞğĞ]/);
    assert.equal(m, null, `${f} contains hardcoded Azerbaijani text near: ${m ? src.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\n/g, ' ') : ''}`);
    assert.equal(/[А-Яа-яЁё]/.test(src), false, `${f} contains hardcoded Cyrillic text`);
  }
});

test('every i18n key used by the UI exists in the dictionary (static key usage + data-i18n attributes)', () => {
  const used = new Set();
  for (const f of uiFiles) {
    const src = readFileSync(new URL(f, PUBLIC), 'utf8');
    for (const m of src.matchAll(/\btr\('([a-zA-Z0-9_.]+)'\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-ph|-aria|-title)?="([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 80, `only ${used.size} keys found, regex broken?`);
  for (const k of used) for (const lang of ['az', 'en']) assert.ok(dict[lang][k], `missing ${lang} key: ${k}`);
});

test('dynamic key families are covered for every enum value (SOS types, needs, point types, statuses, accessibility features, reasons)', () => {
  const families = {
    'sos.': ['FIRE', 'COLLAPSE', 'FLOOD', 'MEDICAL'],
    'm.need.': ['wheelchair', 'reduced_mobility', 'medical_transport'],
    'acc.': ['ramp', 'lift', 'wide_doors', 'accessible_wc'],
    'point.': ['park', 'stadium', 'shelter', 'school'],
    'ui.status.': ['open', 'filling', 'full', 'unreachable'],
    'brigade.': ['available', 'dispatched', 'on_scene', 'offline'],
    'm.reason.': ['POINT_FULL', 'ROAD_BLOCKED', 'POINT_FILLING_FAST', 'NOT_ACCESSIBLE'],
    'd.flag.': ['out_of_area', 'bot_attack', 'low_trust', 'unverified', 'released'],
    'd.sig.': ['burst', 'ip_concentration', 'rhythm', 'fresh_devices'],
    'role.': ['citizen', 'priority'],
  };
  for (const [prefix, vals] of Object.entries(families)) for (const v of vals) for (const lang of ['az', 'en']) assert.ok(dict[lang][prefix + v], `${lang}: ${prefix}${v}`);
});

test('every error code the server can raise has a message in az and en', async () => {
  const src = ['app', 'store', 'crisis', 'evacuation', 'priority', 'scenarios'].map((f) => readFileSync(new URL(`../src/${f}.js`, import.meta.url), 'utf8')).join('\n');
  const codes = new Set([...src.matchAll(/AppError\(\d+, '([A-Z_]+)'\)/g)].map((m) => m[1]));
  assert.ok(codes.size >= 20);
  for (const c of codes) for (const lang of ['az', 'en']) assert.ok(dict[lang][`err.${c}`], `${lang}: err.${c}`);
});

test('the language switch is wired in both apps and applies without a reload', () => {
  const mobile = readFileSync(new URL('mobile.html', PUBLIC), 'utf8');
  const disp = readFileSync(new URL('dispatcher.html', PUBLIC), 'utf8');
  assert.match(mobile, /loadLang\(b\.dataset\.l\);\s*renderStatic\(\);\s*renderAll\(\)/, 'mobile re-renders after loadLang');
  assert.match(disp, /loadLang\(\$\('lang'\)\.value\);\s*statics\(\);\s*snap && render\(\)/, 'dispatcher re-renders after loadLang');
  assert.match(mobile, /LANGS = \['az', 'en', 'ru'\]/);
  assert.match(disp, /<option value="en">EN<\/option>/);
});
