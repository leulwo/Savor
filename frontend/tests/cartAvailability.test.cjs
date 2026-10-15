const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/utils/cartAvailability.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helperModule = { exports: {} };
vm.runInNewContext(compiled, { module: helperModule, exports: helperModule.exports });
const { getUnavailableCartItems } = helperModule.exports;

function savedItem(id, name, choice = {}) {
  return { menuItem: { id, name, price: 149 }, quantity: 1, ...choice };
}

test('the removed beyeaynet cart line is blocked while current Salmon stays available', () => {
  const removedDish = savedItem('eh2m7lobc', 'beyeaynet');
  const salmon = savedItem('5', 'Salmon');
  const cart = [removedDish, salmon];
  const currentMenu = [{ id: '5', name: 'Salmon', isActive: true }];
  const unavailable = getUnavailableCartItems(cart, currentMenu);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0], removedDish);
  assert.equal(cart.length, 2, 'validation preserves the saved cart for explicit customer removal');
  assert.equal(cart[1], salmon);
});

test('current inactive items are blocked even when the saved snapshot was active', () => {
  const inactive = savedItem('inactive', 'Inactive dish');
  inactive.menuItem.isActive = true;
  const normal = savedItem('normal', 'Normal dish');
  const unavailable = getUnavailableCartItems([inactive, normal], [{ id: 'inactive', isActive: false }, { id: 'normal' }]);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0], inactive);
});

test('removed and sold out selected variants are blocked without substituting another option', () => {
  const removedChoice = savedItem('drink', 'Drink', { variationId: 'removed-large' });
  const soldOutChoice = savedItem('drink', 'Drink', { variationId: 'medium' });
  const validChoice = savedItem('drink', 'Drink', { variationId: 'small' });
  const currentMenu = [{ id: 'drink', variations: [{ id: 'small', isAvailable: true }, { id: 'medium', isAvailable: false }] }];
  const unavailable = getUnavailableCartItems([removedChoice, soldOutChoice, validChoice], currentMenu);
  assert.equal(unavailable.length, 2);
  assert.equal(unavailable[0], removedChoice);
  assert.equal(unavailable[1], soldOutChoice);
  assert.equal(removedChoice.variationId, 'removed-large');
});

test('legacy saved variant snapshots are checked when variationId is missing or null', () => {
  const stale = savedItem('drink', 'Drink');
  stale.menuItem.variation = { id: 'removed', label: 'Removed' };
  const valid = savedItem('drink', 'Drink', { variationId: null });
  valid.menuItem.variation = { id: 'small', label: 'Small' };
  const unavailable = getUnavailableCartItems([stale, valid], [{ id: 'drink', variations: [{ id: 'small' }] }]);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0], stale);
});

test('current items without variations accept missing, null, and empty variation choices', () => {
  const cart = [savedItem('5', 'Salmon'), savedItem('5', 'Salmon', { variationId: null }), savedItem('5', 'Salmon', { variationId: '' })];
  assert.equal(getUnavailableCartItems(cart, [{ id: '5', isActive: true }]).length, 0);
  assert.equal(getUnavailableCartItems(cart, [{ id: '5', variations: [] }]).length, 0);
  assert.equal(getUnavailableCartItems([], [{ id: '5' }]).length, 0);
});
