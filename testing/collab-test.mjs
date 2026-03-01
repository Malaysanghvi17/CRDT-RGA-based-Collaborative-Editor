import chalk from "chalk";
import puppeteer from "puppeteer";

const CONFIG = {
  numUsers: 4,
  sentenceLength: 150,
  typingInterval: 30,
  concurrencyDelay: 50,
  appUrl: 'http://localhost:8080/editor',
  headless: false,
  randomness: 0.4,
  syncWait: 2500,       // ms to wait after typing for sync
  editorSelector: 'textarea#editor:not([disabled])',
};

// ============================
// UTILITIES
// ============================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const WORDS = [
  'hello', 'world', 'test', 'collaborative', 'editing', 'system',
  'working', 'perfectly', 'user', 'typing', 'quickly', 'slowly',
  'concurrent', 'operations', 'transform', 'document', 'sync',
  'conflict', 'resolve', 'merge', 'insert', 'delete', 'cursor',
  'position', 'offset', 'broadcast', 'server', 'client', 'state',
];

function generateSentence(length, userId) {
  let sentence = `U${userId}:`;
  while (sentence.length < length) {
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];
    if (sentence.length + w.length + 1 <= length) sentence += ' ' + w;
    else break;
  }
  return sentence.trim().substring(0, length);
}

function generateWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

// ============================
// TEXTAREA UTILITIES
// ============================
async function clearEditor(page, selector) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);
}

async function setContent(page, selector, text) {
  await page.evaluate((sel, txt) => {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      el.value = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector, text);
}

async function typeText(page, selector, text, baseDelay, randomness) {
  const el = await page.$(selector);
  if (!el) return console.error("❌ textarea not found");
  await el.click({ clickCount: 3 });
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selector);
  for (const c of text) {
    await page.type(selector, c);
    await delay(baseDelay + Math.random() * baseDelay * randomness);
  }
}

async function typeAtPosition(page, selector, text, position, baseDelay, randomness) {
  const el = await page.$(selector);
  if (!el) return;
  await page.evaluate((sel, pos) => {
    const el = document.querySelector(sel);
    if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  }, selector, position);
  for (const c of text) {
    await page.type(selector, c);
    await delay(baseDelay + Math.random() * baseDelay * randomness);
  }
}

async function deleteAtPosition(page, selector, position, count, baseDelay) {
  await page.evaluate((sel, pos) => {
    const el = document.querySelector(sel);
    if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  }, selector, position);
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Backspace');
    await delay(baseDelay);
  }
}

async function getContent(page, selector) {
  return await page.evaluate(sel => {
    const el = document.querySelector(sel);
    return el ? el.value : '';
  }, selector);
}

async function getLength(page, selector) {
  return (await getContent(page, selector)).length;
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

function compareContents(contents, userIds, label = '') {
  const base = normalizeText(contents[0]);
  let allMatch = true;
  const header = label ? `📄 ${label}` : '📄 Content Comparison';
  console.log('\n' + header + '\n' + '─'.repeat(80));
  for (let i = 0; i < contents.length; i++) {
    const txt = normalizeText(contents[i]);
    const same = txt === base;
    console.log(`  User ${userIds[i]}: [${txt.length} chars] ${same ? '✅' : '❌'}`);
    if (!same) {
      allMatch = false;
      console.log(chalk.yellow(`  Diff vs User1 (first 300 chars):`));
      console.log(diffStrings(base.substring(0, 300), txt.substring(0, 300)));
    }
  }
  console.log('─'.repeat(80));
  if (allMatch) {
    console.log(chalk.green('✅ All users perfectly synced!'));
  } else {
    console.log(chalk.red('❌ Out-of-sync content detected!'));
  }
  return allMatch;
}

async function syncCheck(pages, config, label) {
  await delay(config.syncWait);
  const contents = await Promise.all(pages.map(p => getContent(p, config.editorSelector)));
  return compareContents(contents, pages.map((_, i) => i + 1), label);
}

// ============================
// TEST HELPERS
// ============================
async function resetEditors(pages, config, initialText = '') {
  console.log(chalk.gray('  ↺ Resetting editors...'));
  for (const page of pages) {
    await clearEditor(page, config.editorSelector);
    await delay(100);
  }
  if (initialText) {
    await setContent(pages[0], config.editorSelector, initialText);
    await delay(500); // let it sync
  }
  await delay(500);
}

// ============================
// TESTS
// ============================

// TEST 1: Basic concurrent typing — all users type simultaneously from scratch
async function testConcurrentTyping(pages, config) {
  console.log(chalk.bold('\n📝 Test 1: Concurrent Typing (all users type at once)'));
  await resetEditors(pages, config);

  const typing = pages.map((page, i) => (async () => {
    await delay(i * config.concurrencyDelay);
    const text = generateSentence(config.sentenceLength, i + 1);
    console.log(`  User ${i + 1} starts typing "${text.substring(0, 30)}..."`);
    await typeText(page, config.editorSelector, text, config.typingInterval, config.randomness);
    console.log(`  User ${i + 1} done.`);
  })());

  await Promise.all(typing);
  return syncCheck(pages, config, 'Test 1: Concurrent Typing');
}

// TEST 2: Multi-location simultaneous inserts — seed doc, users insert at different positions at same time
async function testMultiLocationInserts(pages, config) {
  console.log(chalk.bold('\n📍 Test 2: Simultaneous Inserts at Different Positions'));
  const seed = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.';
  await resetEditors(pages, config, seed);
  await delay(1000);

  const seedLen = seed.length;
  // Spread cursors evenly across the document
  const positions = pages.map((_, i) => Math.floor((i / pages.length) * seedLen));

  const inserts = pages.map((page, i) => (async () => {
    const word = ` [U${i + 1}:${generateWord()}] `;
    console.log(`  User ${i + 1} inserts at pos ${positions[i]}: "${word.trim()}"`);
    await typeAtPosition(page, config.editorSelector, word, positions[i], config.typingInterval, config.randomness);
  })());

  await Promise.all(inserts);
  return syncCheck(pages, config, 'Test 2: Multi-Location Inserts');
}

// TEST 3: Interleaved rapid typing — users alternate typing single chars as fast as possible
async function testInterleavedRapidTyping(pages, config) {
  console.log(chalk.bold('\n⚡ Test 3: Interleaved Rapid Typing (char-by-char alternating)'));
  await resetEditors(pages, config);

  const charsPerUser = 40;
  const ops = [];

  for (let round = 0; round < charsPerUser; round++) {
    for (let i = 0; i < pages.length; i++) {
      ops.push({ page: pages[i], userId: i + 1, char: String.fromCharCode(97 + (round % 26)) });
    }
  }

  // Fire all in rapid parallel bursts of pages.length
  let passed = true;
  for (let round = 0; round < charsPerUser; round++) {
    const burst = pages.map((page, i) => (async () => {
      const char = `${i + 1}`;
      await page.type(config.editorSelector, char);
    })());
    await Promise.all(burst);
    await delay(10);
  }

  return syncCheck(pages, config, 'Test 3: Interleaved Rapid Typing');
}

// TEST 4: Concurrent deletes — all users delete from different positions simultaneously
async function testConcurrentDeletes(pages, config) {
  console.log(chalk.bold('\n🗑️  Test 4: Concurrent Deletes at Different Positions'));
  const seed = 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMM NNNN OOOO PPPP';
  await resetEditors(pages, config, seed);
  await delay(1000);

  const seedLen = seed.length;
  const deleteOps = pages.map((page, i) => (async () => {
    const pos = Math.floor(((i + 1) / (pages.length + 1)) * seedLen);
    const count = 3 + Math.floor(Math.random() * 5);
    console.log(`  User ${i + 1} deletes ${count} chars at pos ~${pos}`);
    await deleteAtPosition(page, config.editorSelector, pos, count, config.typingInterval);
  })());

  await Promise.all(deleteOps);
  return syncCheck(pages, config, 'Test 4: Concurrent Deletes');
}

// TEST 5: Mixed insert + delete — some users type, others delete simultaneously
async function testMixedInsertDelete(pages, config) {
  console.log(chalk.bold('\n🔀 Test 5: Mixed Concurrent Insert + Delete'));
  const seed = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';
  await resetEditors(pages, config, seed);
  await delay(1000);

  const seedLen = seed.length;
  const ops = pages.map((page, i) => (async () => {
    if (i % 2 === 0) {
      // Even users insert
      const pos = Math.floor(Math.random() * seedLen);
      const word = ` [insert-U${i + 1}] `;
      console.log(`  User ${i + 1} INSERTS at pos ${pos}`);
      await typeAtPosition(page, config.editorSelector, word, pos, config.typingInterval, config.randomness);
    } else {
      // Odd users delete
      const pos = Math.floor(((i) / pages.length) * seedLen);
      const count = 4 + Math.floor(Math.random() * 6);
      console.log(`  User ${i + 1} DELETES ${count} chars at pos ~${pos}`);
      await deleteAtPosition(page, config.editorSelector, pos, count, config.typingInterval);
    }
  })());

  await Promise.all(ops);
  return syncCheck(pages, config, 'Test 5: Mixed Insert + Delete');
}

// TEST 6: Burst typing — users type long bursts simultaneously without delay
async function testBurstTyping(pages, config) {
  console.log(chalk.bold('\n💥 Test 6: High-Speed Burst Typing (near-zero delay)'));
  await resetEditors(pages, config);

  const bursts = pages.map((page, i) => (async () => {
    const text = generateSentence(80, i + 1);
    console.log(`  User ${i + 1} burst-typing...`);
    for (const c of text) {
      await page.type(config.editorSelector, c);
      // Almost no delay — maximum stress
      await delay(Math.random() < 0.1 ? 5 : 0);
    }
    console.log(`  User ${i + 1} burst done.`);
  })());

  await Promise.all(bursts);
  return syncCheck(pages, config, 'Test 6: Burst Typing');
}

// TEST 7: Sequential waves — users take turns in overlapping waves
async function testOverlappingWaves(pages, config) {
  console.log(chalk.bold('\n🌊 Test 7: Overlapping Typing Waves'));
  await resetEditors(pages, config);

  const waveDelay = config.typingInterval * 20; // offset each user's start
  const waves = pages.map((page, i) => (async () => {
    await delay(i * waveDelay);
    const text = generateSentence(config.sentenceLength, i + 1);
    console.log(`  User ${i + 1} wave starts (offset ${i * waveDelay}ms)`);
    await typeText(page, config.editorSelector, text, config.typingInterval, config.randomness);
    console.log(`  User ${i + 1} wave done.`);
  })());

  await Promise.all(waves);
  return syncCheck(pages, config, 'Test 7: Overlapping Waves');
}

// TEST 8: Random position multi-round — multiple rounds of random cursor + insert
async function testRandomPositionMultiRound(pages, config) {
  console.log(chalk.bold('\n🎲 Test 8: Multi-Round Random Position Typing'));
  await resetEditors(pages, config);

  const ROUNDS = 5;
  for (let round = 0; round < ROUNDS; round++) {
    console.log(chalk.gray(`  Round ${round + 1}/${ROUNDS}...`));
    const roundOps = pages.map((page, i) => (async () => {
      const currentLen = await getLength(page, config.editorSelector);
      const pos = currentLen > 0 ? Math.floor(Math.random() * currentLen) : 0;
      const word = `[R${round + 1}U${i + 1}] `;
      await typeAtPosition(page, config.editorSelector, word, pos, config.typingInterval * 0.5, 0.2);
    })());
    await Promise.all(roundOps);
    await delay(300);
  }

  return syncCheck(pages, config, 'Test 8: Multi-Round Random Positions');
}

// TEST 9: One user floods, others make small edits
async function testFloodVsSmallEdits(pages, config) {
  console.log(chalk.bold('\n🌊 Test 9: One Flooder vs. Many Small Editors'));
  await resetEditors(pages, config);

  const floodUser = pages[0];
  const smallEditors = pages.slice(1);

  const flood = (async () => {
    const text = generateSentence(config.sentenceLength * 2, 1);
    console.log(`  User 1 flooding (${text.length} chars)...`);
    await typeText(floodUser, config.editorSelector, text, config.typingInterval * 0.5, 0.1);
    console.log(`  User 1 flood done.`);
  })();

  const smalls = smallEditors.map((page, i) => (async () => {
    await delay(200 + i * 150);
    for (let j = 0; j < 3; j++) {
      await delay(300 + Math.random() * 400);
      const currentLen = await getLength(page, config.editorSelector);
      const pos = currentLen > 0 ? Math.floor(Math.random() * currentLen) : 0;
      const word = `[u${i + 2}]`;
      await typeAtPosition(page, config.editorSelector, word, pos, config.typingInterval, 0.2);
    }
    console.log(`  User ${i + 2} small edits done.`);
  })());

  await Promise.all([flood, ...smalls]);
  return syncCheck(pages, config, 'Test 9: Flood vs Small Edits');
}

// TEST 10: Ping-pong — 2 users rapidly alternate single keystrokes
async function testPingPong(pages, config) {
  console.log(chalk.bold('\n🏓 Test 10: Ping-Pong Rapid Alternation (User 1 & 2)'));
  await resetEditors(pages, config);

  const p1 = pages[0], p2 = pages[1];
  const iterations = 30;
  const ping = (async () => {
    for (let i = 0; i < iterations; i++) {
      await p1.type(config.editorSelector, 'A');
      await delay(config.typingInterval * 0.8);
    }
  })();
  const pong = (async () => {
    await delay(config.typingInterval * 0.4); // slight offset
    for (let i = 0; i < iterations; i++) {
      await p2.type(config.editorSelector, 'B');
      await delay(config.typingInterval * 0.8);
    }
  })();

  await Promise.all([ping, pong]);
  return syncCheck(pages, config, 'Test 10: Ping-Pong');
}

// TEST 11: Select-all and overwrite race
async function testSelectAllOverwriteRace(pages, config) {
  console.log(chalk.bold('\n✍️  Test 11: Select-All + Overwrite Race'));
  const seed = 'This entire document will be overwritten by the winner of the race.';
  await resetEditors(pages, config, seed);
  await delay(800);

  // All users select all and type at nearly the same time
  const overwrites = pages.map((page, i) => (async () => {
    await delay(i * 20); // tiny offsets to create race conditions
    await page.click(config.editorSelector);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    const replacement = generateSentence(60, i + 1);
    console.log(`  User ${i + 1} overwrites with: "${replacement.substring(0, 30)}..."`);
    await page.type(config.editorSelector, replacement);
  })());

  await Promise.all(overwrites);
  return syncCheck(pages, config, 'Test 11: Select-All Overwrite Race');
}

// TEST 12: Long sustained concurrent session
async function testLongSustainedSession(pages, config) {
  console.log(chalk.bold('\n⏱️  Test 12: Long Sustained Concurrent Session (60s simulation)'));
  await resetEditors(pages, config);

  const DURATION_MS = 8000;
  const start = Date.now();

  const sessions = pages.map((page, i) => (async () => {
    let ops = 0;
    while (Date.now() - start < DURATION_MS) {
      const action = Math.random();
      const currentLen = await getLength(page, config.editorSelector);

      if (action < 0.6 || currentLen === 0) {
        // Type a word
        const pos = currentLen > 0 ? Math.floor(Math.random() * currentLen) : 0;
        await typeAtPosition(page, config.editorSelector, ' ' + generateWord(), pos, 20, 0.3);
      } else if (action < 0.85 && currentLen > 5) {
        // Delete a few chars
        const pos = Math.max(3, Math.floor(Math.random() * currentLen));
        await deleteAtPosition(page, config.editorSelector, pos, 1 + Math.floor(Math.random() * 3), 15);
      } else {
        // Short pause (user thinking)
        await delay(100 + Math.random() * 300);
      }
      ops++;
    }
    console.log(`  User ${i + 1} completed ${ops} ops.`);
  })());

  await Promise.all(sessions);
  return syncCheck(pages, config, 'Test 12: Long Sustained Session');
}

// ============================
// MAIN RUNNER
// ============================
async function runTests() {
  console.log(chalk.bold.cyan('\n🚀 ENHANCED TEXTAREA COLLAB EDIT TEST SUITE'));
  console.log('='.repeat(80));
  console.log(`  Users: ${CONFIG.numUsers} | URL: ${CONFIG.appUrl}`);
  console.log('='.repeat(80));

  const browser = await puppeteer.launch({
    headless: CONFIG.headless,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 800 },
  });

  const pages = [];
  for (let i = 0; i < CONFIG.numUsers; i++) {
    const page = await browser.newPage();
    await page.goto(CONFIG.appUrl, { waitUntil: 'networkidle2' });

    // Manually force a unique user ID in local storage to prevent collisions
    await page.evaluate((idx) => {
      localStorage.setItem('collab-user-id', 'testuser-' + idx);
    }, i + 1);

    // Reload so main.ts picks up the distinct ID
    await page.reload({ waitUntil: 'networkidle2' });

    pages.push(page);
  }

  await Promise.all(pages.map(async (page, i) => {
    await page.waitForSelector(CONFIG.editorSelector, { visible: true, timeout: 15000 });
    console.log(`✅ User ${i + 1} editor ready`);
  }));

  await delay(1500);

  const results = [];

  const tests = [
    ['Test 1', testConcurrentTyping],
    ['Test 2', testMultiLocationInserts],
    ['Test 3', testInterleavedRapidTyping],
    ['Test 4', testConcurrentDeletes],
    ['Test 5', testMixedInsertDelete],
    ['Test 6', testBurstTyping],
    ['Test 7', testOverlappingWaves],
    ['Test 8', testRandomPositionMultiRound],
    ['Test 9', testFloodVsSmallEdits],
    ['Test 10', testPingPong],
    ['Test 11', testSelectAllOverwriteRace],
    ['Test 12', testLongSustainedSession],
  ];

  for (const [name, fn] of tests) {
    try {
      const passed = await fn(pages, CONFIG);
      results.push({ name, passed });
    } catch (err) {
      console.error(chalk.red(`💥 ${name} threw an error: ${err.message}`));
      results.push({ name, passed: false, error: err.message });
    }
    await delay(1000); // brief cooldown between tests
  }

  // ============================
  // SUMMARY
  // ============================
  console.log(chalk.bold('\n' + '='.repeat(80)));
  console.log(chalk.bold('📊 FINAL RESULTS'));
  console.log('='.repeat(80));
  let totalPassed = 0;
  for (const { name, passed, error } of results) {
    const icon = passed ? chalk.green('✅ PASS') : chalk.red('❌ FAIL');
    const errNote = error ? chalk.gray(` (${error})`) : '';
    console.log(`  ${icon}  ${name}${errNote}`);
    if (passed) totalPassed++;
  }
  console.log('─'.repeat(80));
  const allPassed = totalPassed === results.length;
  console.log(
    allPassed
      ? chalk.green.bold(`\n🎉 All ${results.length} tests passed!`)
      : chalk.red.bold(`\n⚠️  ${totalPassed}/${results.length} tests passed.`)
  );
  console.log('='.repeat(80));

  await delay(3000);
  await browser.close();
}

runTests().catch(console.error);
