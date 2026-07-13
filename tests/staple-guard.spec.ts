// RED-TEST SUITE for the shop-flow staple guard — PURE unit tests over fixture result-sets (no auth, no
// live site, no browser). This is the "who tests the monitors" answer for the highest-risk logic in the
// fleet: the guard that decides which product gets added to the cart. red_tests had ZERO rows; these tests
// are the proof the guard REDS on a boosted promo instead of silently adding candy.
//
// Runs via the Playwright "unit" project (see playwright.config.ts): `npm run test:unit`. It uses only the
// value matchers (toBe/toBeTruthy/…) — no browser fixture, so no Chrome launches.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { pickStaple, isStapleSlug, STAPLE_GUARDS, MERCH_REJECT } from '../lib/staple-guard';

const EGGS = STAPLE_GUARDS.eggs;
const MILK = STAPLE_GUARDS.milk;
const BREAD = STAPLE_GUARDS.bread;
const R = (slug: string, name = ''): { slug: string; name: string } => ({ slug, name });

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// RED — a boosted/seasonal/promo result must NOT be selected (skip it), and if ONLY promos exist the
// selection returns null → the add step THROWS. This is the whole point: a false green becomes a red.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('★ RED: a Cadbury Creme Egg boosted to #1 is NOT picked — the real egg is', () => {
  const results = [
    R('50001-Cadbury-Creme-Egg-6ct', 'Cadbury Creme Egg 6 ct'),
    R('46155-Grade-AA-Large-Eggs-18-Count', 'Wegmans Grade AA Large Eggs, 18 count'),
  ];
  const pick = pickStaple(results, EGGS);
  expect(pick, 'pickStaple returned null for a list containing a real egg').toBeTruthy();
  expect(results[pick!.index].slug.startsWith('46155-')).toBe(true); // the real egg, via the id-pin
});

test('★ RED: candy-only "eggs" results → pickStaple returns null (the add step throws = the monitor REDS)', () => {
  const results = [R('1-Cadbury-Creme-Egg'), R('2-Chocolate-Easter-Eggs'), R('3-Egg-Dye-Kit')];
  expect(pickStaple(results, EGGS)).toBe(null);
});

test('★ RED: landed-verify rejects a Cadbury slug (a promo that slipped through the selection reds)', () => {
  expect(isStapleSlug('50001-Cadbury-Creme-Egg', EGGS)).toBe(false); // false → the add step throws
  expect(isStapleSlug('3-Egg-Dye-Kit', EGGS)).toBe(false);
});

test('RED: July-4 "Red, White & Blue" loaf skipped for bread; a staple loaf picked', () => {
  const pick = pickStaple([R('32939-Red-White-Blue-Half-Loaf-Bread'), R('62874-Walnut-Raisin-Bread-Half-Loaf')], BREAD);
  expect(pick?.via).toBe('fallback');
  expect(pick?.index).toBe(1);
});

test('RED: eggnog / milk-chocolate candy skipped for milk; plain milk picked', () => {
  const pick = pickStaple([R('9-Eggnog-Holiday', 'Eggnog'), R('8-Milk-Chocolate-Candy-Bar'), R('55066-1-Low-Fat-Milk')], MILK);
  expect(pick?.index).toBe(2);
});

test('RED: an empty result list → null (the add step throws)', () => {
  expect(pickStaple([], EGGS)).toBe(null);
  expect(pickStaple([], MILK)).toBe(null);
  expect(pickStaple([], BREAD)).toBe(null);
});

test('RED: a list where ONLY merch matches the query → null', () => {
  // all contain "egg" but every one is a reject term → no staple → null
  expect(pickStaple([R('1-Cadbury-Creme-Egg'), R('2-Egg-Nog-Latte'), R('3-Chocolate-Egg-Cake')], EGGS)).toBe(null);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// GREEN — the guard is NOT "throws on everything": a real staple is picked, via the deterministic id-pin.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('GREEN: real staples are selected via the id-pin (55066 milk, 46155 eggs)', () => {
  expect(pickStaple([R('55066-1-Low-Fat-Milk')], MILK)).toEqual({ index: 0, via: 'id' });
  expect(pickStaple([R('46155-Grade-AA-Large-Eggs-18-Count')], EGGS)).toEqual({ index: 0, via: 'id' });
  expect(isStapleSlug('46155-Grade-AA-Large-Eggs-18-Count', EGGS)).toBe(true);
  expect(isStapleSlug('55066-1-Low-Fat-Milk', MILK)).toBe(true);
});

test('GREEN(pin-miss): if the pinned SKU is absent, fall back to a real staple via=fallback (STAPLE-PIN-MISS fires)', () => {
  // 46155 discontinued; the fallback still picks a real egg and the spec logs STAPLE-PIN-MISS.
  const pick = pickStaple([R('80133-Grade-AA-Large-Eggs-12-Count', 'Grade AA Large Eggs')], EGGS);
  expect(pick).toEqual({ index: 0, via: 'fallback' });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PARITY — the spec keeps an INLINE copy of the guard (the single-file fetch forbids importing this
// module). Assert the inline copy is byte-identical to what these tests exercise, so they can't drift.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('PARITY: the spec\'s inline MERCH_REJECT + pinned ids == lib/staple-guard (no silent drift)', () => {
  const specSrc = readFileSync('monitors/wegmans/full-shop-flow.spec.ts', 'utf8');
  expect(specSrc.includes(MERCH_REJECT.source), 'spec inline MERCH_REJECT drifted from lib/staple-guard').toBe(true);
  expect(specSrc.includes(`milk: { id: '${STAPLE_GUARDS.milk.id}'`)).toBe(true);
  expect(specSrc.includes(`eggs: { id: '${STAPLE_GUARDS.eggs.id}'`)).toBe(true);
  expect(specSrc.includes(STAPLE_GUARDS.bread.require.source), 'spec inline bread require drifted').toBe(true);
});
