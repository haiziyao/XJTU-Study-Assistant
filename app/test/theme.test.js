import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../src/renderer/kit/theme.js', import.meta.url), 'utf8');
function setup({ saved, dark = false, blocked = false } = {}) {
  const values = new Map(saved ? [['zhixue.appearance', saved]] : []);
  const attrs = {};
  const events = {};
  const mediaEvents = {};
  const media = { matches: dark, addEventListener: (name, handler) => { mediaEvents[name] = handler; } };
  const context = {
    document: { readyState: 'loading', documentElement: { setAttribute: (key, value) => { attrs[key] = value; } }, getElementById: () => null, addEventListener() {} },
    matchMedia: () => media,
    localStorage: { getItem(key) { if (blocked) throw new Error('blocked'); return values.get(key); }, setItem(key, value) { if (blocked) throw new Error('blocked'); values.set(key, value); } },
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return { theme: context.PCTheme, attrs, values, events, media, mediaEvents };
}

test('外观初次跟随系统，主动切换会记住选择并在下次打开恢复', () => {
  const app = setup();
  assert.equal(app.attrs['data-theme'], 'light');
  app.theme.toggle();
  assert.equal(app.attrs['data-theme'], 'dark');
  assert.equal(app.values.get('zhixue.appearance'), 'dark');
  const reopened = setup({ saved: app.values.get('zhixue.appearance') });
  assert.equal(reopened.attrs['data-theme'], 'dark');
  reopened.theme.toggle();
  assert.equal(reopened.attrs['data-theme'], 'light');
});

test('系统变化只影响跟随系统模式；其他页面的偏好变更会同步', () => {
  const app = setup();
  app.media.matches = true; app.mediaEvents.change();
  assert.equal(app.attrs['data-theme'], 'dark');
  app.theme.setMode('light'); app.mediaEvents.change();
  assert.equal(app.attrs['data-theme'], 'light');
  app.events.storage({ key: 'zhixue.appearance', newValue: 'dark' });
  assert.equal(app.attrs['data-theme'], 'dark');
  app.events.storage({ key: null, newValue: null });
  assert.equal(app.theme.getMode(), 'system');
});

test('存储被禁用或偏好无效时仍能使用外观切换', () => {
  const app = setup({ blocked: true });
  assert.equal(app.attrs['data-theme'], 'light');
  app.theme.setMode('dark');
  assert.equal(app.attrs['data-theme'], 'dark');
  assert.equal(setup({ saved: 'unknown' }).theme.getMode(), 'system');
});
