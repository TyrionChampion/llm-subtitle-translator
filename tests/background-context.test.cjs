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
