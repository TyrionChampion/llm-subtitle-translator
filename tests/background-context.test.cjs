const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C = require('../translation-context.js');
const code = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8')
  .replace('import "./translation-context.js";', '');
async function request(mode, profile, provider = 'custom') {
  let listener, body;
  const context = {
    LLMTranslationContext: C,
    AbortController, setTimeout, clearTimeout,
    chrome: { storage: { sync: { get: async defaults => ({...defaults, provider,
      apiKeys: {[provider]:'fake-test-only'}, models: {[provider]:'unchanged-model'},
      customEndpoint:'https://api.deepseek.com/chat/completions', translationMode:mode,
      f1ContextLines:2}) } }, runtime: {
      onMessage:{addListener:fn => listener=fn}, onInstalled:{addListener(){}},
    } },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return {ok:true, json:async () => ({choices:[{message:{content:'进站'}}],
        data:{translations:[{translatedText:'进站'}]}})};
    },
  };
  vm.runInNewContext(code, context);
  const response = await new Promise(resolve => listener({type:'translate',lines:['Box, box'],
    history:[{source:'old',translation:'BAD_HISTORY'}], translationProfile:profile,
    sourceContext:['too old','first','second']}, {}, resolve));
  assert.equal(response.ok, true);
  return body;
}
test('DeepSeek uses bounded source context and glossary without changing model', async () => {
  const b = await request('auto','f1');
  assert.equal(b.model,'unchanged-model');
  assert.equal(b.thinking.type,'disabled');
  assert.match(b.messages[0].content,/chicane=减速弯/);
  assert.match(b.messages[1].content,/\["first","second"\]/);
  assert.doesNotMatch(b.messages[1].content,/BAD_HISTORY|too old/);
  assert.ok(b.messages[1].content.endsWith('Box, box'));
});
test('off keeps ordinary prompt and history; forced mode works without page detection', async () => {
  const off = await request('off','f1');
  assert.doesNotMatch(off.messages[0].content,/Formula 1 commentary/);
  assert.match(off.messages[1].content,/BAD_HISTORY/);
  const forced = await request('f1','general');
  assert.match(forced.messages[0].content,/Formula 1 commentary/);
});
test('Google Translate path remains prompt-free', async () => {
  const b = await request('f1','f1','google-translate');
  assert.deepEqual(b.q,['Box, box']);
  assert.equal(b.messages,undefined);
});

function timeoutHarness(fetch) {
  const timers = new Map();
  const delays = [];
  let nextId = 0, clears = 0;
  const context = {
    AbortController, TextEncoder, btoa, atob, fetch,
    crypto: {subtle: {importKey: async () => ({}), sign: async () => new ArrayBuffer(1)}},
    chrome: {runtime: {onMessage: {addListener() {}}, onInstalled: {addListener() {}}}},
    setTimeout(fn, delay) {
      delays.push(delay);
      timers.set(++nextId, fn);
      return nextId;
    },
    clearTimeout(id) { clears++; timers.delete(id); },
  };
  vm.runInNewContext(code, context);
  return {context, timers, delays, get clears() { return clears; },
    expire() { for (const fn of [...timers.values()]) fn(); }};
}

for (const stage of ['fetch', 'json', 'text']) {
  test(`request deadline covers stalled ${stage} even when abort is ignored`, async () => {
    let signal, entered;
    const started = new Promise(resolve => entered = resolve);
    const stalled = () => { entered(); return new Promise(() => {}); };
    const h = timeoutHarness(async (_url, init) => {
      signal = init.signal;
      if (stage === 'fetch') return stalled();
      return {ok: stage === 'json', status: 503, json: stalled, text: stalled};
    });
    const pending = h.context.fetchJsonWithTimeout('https://example.test', {}, '测试 API');
    const rejection = assert.rejects(pending, /测试 API 请求超时（12 秒），请稍后重试。/);
    await started;
    assert.equal(signal.aborted, false);
    assert.equal(h.timers.size, 1, 'deadline remains active during body read');
    assert.deepEqual(h.delays, [12000]);
    h.expire();
    await rejection;
    assert.equal(signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.clears, 1);
  });
}

test('timeout takes precedence over fetch abort rejection', async () => {
  const h = timeoutHarness((_url, {signal}) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('AbortError')));
  }));
  const pending = h.context.fetchJsonWithTimeout('https://example.test', {}, 'OAuth2');
  const rejection = assert.rejects(pending, /OAuth2 请求超时/);
  h.expire();
  await rejection;
  assert.equal(h.timers.size, 0);
});

for (const outcome of ['success', 'http-error', 'json-error', 'network-error']) {
  test(`request clears its timer after ${outcome}`, async () => {
    let signal;
    const original = new Error(outcome);
    const h = timeoutHarness((_url, init) => {
      signal = init.signal;
      if (outcome === 'network-error') throw original;
      return Promise.resolve({ok: outcome !== 'http-error', status: 429,
        text: async () => 'x'.repeat(400),
        json: async () => { if (outcome === 'json-error') throw original; return {value: 42}; }});
    });
    const pending = h.context.fetchJsonWithTimeout('https://example.test', {}, '测试');
    if (outcome === 'success') assert.deepEqual(await pending, {value: 42});
    else if (outcome === 'http-error') {
      await assert.rejects(pending, err => err.message === `测试 429: ${'x'.repeat(300)}`);
    } else await assert.rejects(pending, err => err === original);
    assert.equal(h.timers.size, 0);
    assert.equal(h.clears, 1);
    h.expire();
    assert.equal(signal.aborted, false, 'completed requests must not be aborted later');
  });
}

test('all providers and OAuth exchange pass distinct request signals and clean timers', async () => {
  const calls = [];
  const h = timeoutHarness(async (url, init) => {
    calls.push({url, init});
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return {ok: true, json: async () => ({access_token: 'test-token', expires_in: 3600})};
  });
  const common = {apiKey: 'test-only', model: 'unchanged', system: 'system', user: 'user', temperature: 0.2};
  await h.context.callGemini(common);
  await h.context.callOpenAICompatible(common);
  await h.context.callOpenAICompatible({...common, endpointOverride: 'https://custom.test'});
  await h.context.callAnthropic(common);
  await h.context.callGoogleTranslate({apiKey: 'test-only', targetCode: 'zh-CN', lines: ['box']});
  await h.context.callGoogleTranslateV3({serviceAccountJson: JSON.stringify({
    client_email: 'test@example.test', private_key: 'AA==', project_id: 'test-project',
  }), targetCode: 'zh-CN', lines: ['box']});
  assert.equal(calls.length, 7);
  assert.equal(calls[5].url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[6].url, /\/v3\/projects\/test-project\//);
  assert.equal(new Set(calls.map(call => call.init.signal)).size, 7);
  assert.deepEqual(h.delays, Array(7).fill(12000));
  assert.equal(h.timers.size, 0);
  assert.equal(h.clears, 7);
});
