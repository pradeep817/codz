// Tests for form screens: feature add's create and edit screens come with a test
// that fills the inputs, checks what was sent, and checks the error.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import type { Adapter, ChangeSet } from '../src/core/types.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const SPEC = join(REPO, 'examples/openapi.yaml');

async function feature(fixture: string, id: keyof typeof ADAPTERS): Promise<ChangeSet> {
  const dir = copyFixture(fixture);
  try {
    return (await planFeatureAdd(dir, ADAPTERS[id] as Adapter, { name: 'products', spec: SPEC })).changeSet;
  } finally {
    cleanup(dir);
  }
}
const file = (cs: ChangeSet, re: RegExp) => {
  const ch = cs.changes.find((c) => re.test(c.path));
  assert.ok(ch?.after, `no ${re} in ${cs.changes.map((c) => c.path).join(', ')}`);
  return ch.after;
};

describe('form tests', () => {
  it('Next.js: inputs by label, the body the API function got, Saved. and the error; the edit form waits for the loaded values', async () => {
    const cs = await feature('nextjs-helper', 'nextjs');
    const t = file(cs, /app\/products\/new\/page\.test\.tsx$/);
    assert.match(t, /fireEvent\.change\(screen\.getByLabelText\(\/\^name\( \\\*\)\?\$\/\), \{ target: \{ value: "Typed name" \} \}\)/);
    assert.match(t, /expect\.objectContaining\(\{"name":"Typed name",.*"price":3,.*"tags":\["a","b"\]\}\)/);
    assert.match(t, /findByText\('Saved\.'\)/);
    assert.match(t, /mockRejectedValue\(new Error\('boom'\)\)/);
    const edit = file(cs, /edit\/page\.test\.tsx$/);
    assert.match(edit, /vi\.mock\('next\/navigation', \(\) => \(\{ useParams: \(\) => \(\{ productId: '1' \}\)/);
    assert.match(edit, /getProduct: vi\.fn\(\)/);
    assert.match(edit, /await screen\.findByDisplayValue\("Sample name 1"\);/);
  });

  it('React Native: TextInputs in order, Alert watched, required inputs asked for', async () => {
    const cs = await feature('rn-app', 'react-native');
    const t = file(cs, /NewProductScreen\.test\.tsx$/);
    assert.match(t, /UNSAFE_getAllByType\(TextInput\)/);
    assert.match(t, /fireEvent\.changeText\(inputs\[2\], "3"\)/);
    assert.match(t, /toHaveBeenCalledWith\('name is required'\)/);
    assert.match(t, /toHaveBeenCalledWith\('Could not save', 'boom'\)/);
  });

  it('Flutter: required inputs, what Save sends, and the error, with the current values answered for the edit form', async () => {
    const cs = await feature('flutter-riverpod', 'flutter');
    const t = file(cs, /test\/.*new_product.*_test\.dart$/);
    assert.match(t, /expect\(find\.text\('Required'\), findsWidgets\);\n\s+expect\(api\.sent, isEmpty\);/);
    assert.match(t, /enterText\(find\.widgetWithText\(TextFormField, 'name'\), 'Typed name'\)/);
    assert.match(t, /expect\(api\.sent\.single\.method, 'POST'\);/);
    assert.match(t, /productRepositoryProvider\.overrideWithValue/);
    const edit = file(cs, /test\/.*edit_product.*_test\.dart$/);
    assert.match(edit, /_FormApi\(200, response, load: current\)/);
    assert.match(edit, /EditProductPage\(productId: '1'\)/);
  });

  it('Android: submit() with example values against MockWebServer', async () => {
    const cs = await feature('android-app', 'android');
    const t = file(cs, /NewProductViewModelTest\.kt$/);
    assert.match(t, /vm\.submit\(ProductInput\(name = "Typed name", price = 4\.5, category = "Typed category"\)\)/);
    assert.match(t, /assertEquals\("POST", request\.method\)/);
    assert.match(t, /import okhttp3\.mockwebserver\.Dispatcher/);
  });
});
