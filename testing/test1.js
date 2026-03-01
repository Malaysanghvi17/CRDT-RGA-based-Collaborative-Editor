import chalk from "chalk";
import puppeteer from "puppeteer";

const CONFIG = {
  numUsers: 1,
  sentenceLength: 500,
  typingInterval: 50,
  concurrencyDelay: 50,
  appUrl: 'http://localhost:8080/editor?doc=default',
  // appUrl: 'https://collab-ot-project-latest.onrender.com/',
  headless: false,
  randomness: 0.3,
};

// ============================
// UTILITIES
// ============================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function generateSentence(length, userId) {
  const words = [
    // 'hello','world','test','collaborative','editing','system',
    // 'working','perfectly','user','typing','quickly','slowly',
    // 'concurrent','operations','transform','document','sync'
    "t"
  ];
  let sentence = `U${userId}: `;
  while (sentence.length < length) {
    const w = words[Math.floor(Math.random() * words.length)];
    if (sentence.length + w.length + 1 <= length) sentence += w + ' ';
    else break;
  }
  return sentence.trim().substring(0, length);
}

// ============================
// TEXTAREA UTILITIES
// ============================

// Type text naturally into textarea
async function typeText(page, selector, text, baseDelay, randomness) {
  const el = await page.$(selector);
  if (!el) return console.error("❌ textarea not found");
  await el.click({ clickCount: 3 }); // focus + select all (optional clear)
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.value = ''; // clear existing
  }, selector);

  for (const c of text) {
    await page.type(selector, c);
    await delay(baseDelay + Math.random() * baseDelay * randomness);
  }
}

// Insert text at a given position inside textarea
async function typeAtPosition(page, selector, text, position, baseDelay, randomness) {
  const el = await page.$(selector);
  if (!el) return;

  await el.focus();
  // Move cursor to desired position
  await page.evaluate((sel, pos) => {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, selector, position);

  for (const c of text) {
    await page.type(selector, c);
    await delay(baseDelay + Math.random() * baseDelay * randomness);
  }
}

// Get textarea value (instead of innerText)
async function getContent(page, selector) {
  return await page.evaluate(sel => {
    const el = document.querySelector(sel);
    return el ? el.value : '';
  }, selector);
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ============================
// TEXT COMPARISON
// ============================
function diffStrings(a, b) {
  const len = Math.max(a.length, b.length);
  let out = '';
  for (let i = 0; i < len; i++) {
    const A = a[i] || '', B = b[i] || '';
    if (A === B) out += chalk.green(A);
    else if (!A && B) out += chalk.blue(`{+${B}}`);
    else if (A && !B) out += chalk.red(`{-${A}}`);
    else out += chalk.red(`{${A}->${B}}`);
  }
  return out;
}

function compareContents(contents, userIds) {
  const base = normalizeText(contents[0]);
  let allMatch = true;
  console.log('\n📄 Content Comparison\n' + '─'.repeat(80));
  for (let i = 0; i < contents.length; i++) {
    const txt = normalizeText(contents[i]);
    const same = txt === base;
    console.log(`User ${userIds[i]}: ${same ? '✅' : '❌'}`);
    if (!same) {
      allMatch = false;
      console.log(chalk.yellow(`Diff vs User1:`));
      console.log(diffStrings(base, txt));
    }
  }
  console.log('─'.repeat(80));
  console.log(allMatch ? chalk.green('✅ All users perfectly synced!') : chalk.red('❌ Some out-of-sync content!'));
  return allMatch;
}

// ============================
// TESTS
// ============================
async function testConcurrentTyping(pages, config) {
  console.log('\n📝 Test 1: Concurrent Typing (Textarea)');
  const editorSelector = 'textarea#editor:not([disabled])';

  // Clear textarea content
  await pages[0].evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, editorSelector);

  await delay(500);

  const typing = pages.map((page, i) => (async () => {
    await delay(i * config.concurrencyDelay);
    const text = generateSentence(config.sentenceLength, i + 1);
    console.log(`User ${i + 1} typing...`);
    await typeText(page, editorSelector, text, config.typingInterval, config.randomness);
    console.log(`User ${i + 1} done.`);
  })());

  await Promise.all(typing);
  await delay(2000);

  const contents = await Promise.all(pages.map(p => getContent(p, editorSelector)));
  const userIds = pages.map((_, i) => i + 1);
  const passed = compareContents(contents, userIds);
  console.log(passed ? '✅ Test PASSED' : '❌ Test FAILED');
  return passed;
}

// ============================
// MAIN RUNNER
// ============================
async function runTests() {
  console.log('\n🚀 TEXTAREA COLLAB EDIT TEST SUITE');
  console.log('='.repeat(80));

  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 800 }
  });

  const pages = [];
  for (let i = 0; i < CONFIG.numUsers; i++) {
    const page = await browser.newPage();
    await page.goto(CONFIG.appUrl, { waitUntil: 'networkidle2' });
    pages.push(page);
  }

  // Wait for textarea to appear
  const editorSelector = 'textarea#editor:not([disabled])';
  await Promise.all(pages.map(async (page, i) => {
    await page.waitForSelector(editorSelector, { visible: true, timeout: 0 });
    console.log(`✅ User ${i + 1} editor detected`);
  }));

  await delay(2000);

  // Run one main test (you can add others easily)
  await testConcurrentTyping(pages, CONFIG);

  await delay(3000);
  await browser.close();
}

runTests().catch(console.error);
