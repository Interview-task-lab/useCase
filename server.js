const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const { Pool } = require('pg');

// ─── Express Setup ───────────────────────────────────────────────────────────
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve generated Playwright HTML reports
const REPORTS_DIR = path.join(__dirname, 'temp', 'reports');
app.use('/reports', express.static(REPORTS_DIR));

// ─── Temp Directory Resiliency ───────────────────────────────────────────────
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Config Helper ───────────────────────────────────────────────────────────
function getConfig() {
  try {
    const cfgPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    }
  } catch (e) {
    console.warn('Could not load config.json:', e);
  }
  return { targetUrl: 'https://www.enuygun.com/' };
}

app.get('/api/config', (req, res) => {
  res.json({ success: true, config: getConfig() });
});

// ─── PostgreSQL Pool ─────────────────────────────────────────────────────────
const pool = new Pool({
  host: 'localhost',
  port: 5434,
  user: 'codegen_user',
  password: 'codegen_password',
  database: 'codegen_db',
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_cases (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        url TEXT,
        language VARCHAR(50) NOT NULL,
        code TEXT NOT NULL,
        steps JSONB NOT NULL,
        platform VARCHAR(20) DEFAULT 'web',
        app_id VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Add platform and app_id columns if missing (migration)
    try {
      await pool.query(`ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT 'web'`);
      await pool.query(`ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS app_id VARCHAR(255) DEFAULT ''`);
    } catch (_) { }
    console.log('✅ Database connected & test_cases table ready.');
  } catch (err) {
    console.error('⚠️  Could not connect to PostgreSQL. Test saving will be unavailable.');
    console.error('   Run "docker-compose up -d" to start the database container.');
    console.error('   Error:', err.message);
  }
}

// ─── Active Process Tracker (Playwright Web Recording) ───────────────────────
let activeProcess = null;
let processExited = false;
let processExitCode = null;
let processError = null;
let lastRecordingUrl = '';
let lastRecordingLanguage = '';
let lastRecordingPlatform = 'web';
let killTimeout = null;

const MAX_EXECUTION_MS = 10 * 60 * 1000; // 10 minutes
const OUTPUT_FILE = path.join(TEMP_DIR, 'raw_script.js');

function getOutputFile() {
  if (lastRecordingPlatform === 'android' || lastRecordingPlatform === 'ios') {
    return path.join(TEMP_DIR, 'raw_script.js'); // WDIO scripts are also JS
  }
  return OUTPUT_FILE;
}

function cleanupProcess() {
  if (killTimeout) {
    clearTimeout(killTimeout);
    killTimeout = null;
  }
  activeProcess = null;
}

// ─── Test Runner Tracker ─────────────────────────────────────────────────────
let runnerProcess = null;
let runnerState = 'idle'; // idle | running | completed | error
let runnerTestId = null;
let runnerOutput = '';
let runnerReportPath = null;

// ─── Appium / WebdriverIO Session ────────────────────────────────────────────
let appiumProcess = null;
let wdioSession = null;
let wdioSessionPlatform = null;
let wdioSessionAppId = null;

async function ensureAppiumRunning() {
  // Check if Appium is already running on port 4723
  try {
    const resp = await fetch('http://127.0.0.1:4723/status');
    if (resp.ok) {
      console.log('✅ Appium server already running on port 4723');
      return;
    }
  } catch (_) { }

  // Start Appium as a child process
  console.log('🚀 Starting Appium server on port 4723...');
  appiumProcess = spawn('appium', ['--port', '4723', '--relaxed-security'], {
    stdio: 'pipe',
    shell: true,
  });

  appiumProcess.stdout.on('data', (d) => console.log(`[appium] ${d.toString().trim()}`));
  appiumProcess.stderr.on('data', (d) => console.log(`[appium] ${d.toString().trim()}`));
  appiumProcess.on('close', (code) => {
    console.log(`[appium] Process exited with code ${code}`);
    appiumProcess = null;
  });

  // Wait for Appium to be ready (max ~15 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await fetch('http://127.0.0.1:4723/status');
      if (resp.ok) {
        console.log('✅ Appium server is ready');
        return;
      }
    } catch (_) { }
  }
  console.warn('⚠️  Appium may not be fully ready yet');
}

async function createWdioSession(platform, appId) {
  // If already have a matching session, reuse it
  if (wdioSession && wdioSessionPlatform === platform && wdioSessionAppId === appId) {
    try {
      // Verify session is alive
      await wdioSession.getTitle();
      return wdioSession;
    } catch (_) {
      wdioSession = null;
    }
  }

  // Destroy existing session if it exists
  await destroyWdioSession();

  const { remote } = require('webdriverio');

  let capabilities;
  if (platform === 'android') {
    const pkg = appId || 'com.ismailaslan.flutter_login_app';
    capabilities = {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': pkg,
      'appium:appActivity': pkg + '.MainActivity',
      'appium:noReset': true,
      'appium:newCommandTimeout': 600,
      'appium:uiautomator2ServerInstallTimeout': 60000,
    };
  } else {
    // iOS
    const udid = getBootedSimulatorUDID();
    capabilities = {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': appId || 'com.ismailaslan.flutterloginapp',
      'appium:noReset': true,
      'appium:newCommandTimeout': 600,
      'appium:udid': udid !== 'booted' ? udid : undefined,
    };
  }

  console.log(`📱 Creating WebdriverIO ${platform.toUpperCase()} session with capabilities:`, JSON.stringify(capabilities));

  wdioSession = await remote({
    hostname: '127.0.0.1',
    port: 4723,
    path: '/',
    capabilities,
    logLevel: 'warn',
    connectionRetryTimeout: 60000,
    connectionRetryCount: 3,
  });

  wdioSessionPlatform = platform;
  wdioSessionAppId = appId;
  console.log(`✅ WebdriverIO ${platform.toUpperCase()} session created successfully`);
  return wdioSession;
}

async function destroyWdioSession() {
  if (wdioSession) {
    try {
      await wdioSession.deleteSession();
    } catch (_) { }
    wdioSession = null;
    wdioSessionPlatform = null;
    wdioSessionAppId = null;
    console.log('🔌 WebdriverIO session destroyed');
  }
}

function getBootedSimulatorUDID() {
  try {
    const out = execSync('xcrun simctl list devices booted --json', { encoding: 'utf-8' });
    const json = JSON.parse(out);
    for (const runtime of Object.values(json.devices || {})) {
      for (const device of runtime) {
        if (device.state === 'Booted') return device.udid;
      }
    }
  } catch (_) { }
  return 'booted';
}

// ─── Code-to-Steps Parser ───────────────────────────────────────────────────
function parseCodeToSteps(code, language) {
  if (!code || typeof code !== 'string') return [];

  // Uncomment any assertions recorded as comments by Codegen
  const cleanedCode = code.replace(/^\s*\/\/\s*(await\s+expect\(.*)/gm, '$1');
  const lines = cleanedCode.split('\n');
  const steps = [];
  let stepNum = 1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('import ') || line.startsWith('const ') ||
      line.startsWith('from ') || line.startsWith('async ') || line.startsWith('await browser') ||
      line.startsWith('await context') || line === '});' || line === '})' || line === '}' ||
      line === '{' || line.startsWith('test(') || line.startsWith('test.describe') ||
      line.startsWith('module.') || line.startsWith('exports.') || line.startsWith('require(') ||
      line.startsWith('describe(') || line.startsWith('it(') || line.startsWith('before(') ||
      line.startsWith('after(')) {
      continue;
    }

    let description = null;

    // ── WDIO mobile patterns ──
    // $('~id').click()
    const wdioClickId = line.match(/\$\(['"]~(.*?)['"]\)\.click/);
    if (!description && wdioClickId) {
      description = `Tap on element with ID "${wdioClickId[1]}"`;
    }

    // $('~id').setValue('text')
    const wdioSetValue = line.match(/\$\(['"]~(.*?)['"]\)\.setValue\(['"](.+?)['"]\)/);
    if (!description && wdioSetValue) {
      description = `Input "${wdioSetValue[2]}" into element "${wdioSetValue[1]}"`;
    }

    // $('~id').addValue('text')
    const wdioAddValue = line.match(/\$\(['"]~(.*?)['"]\)\.addValue\(['"](.+?)['"]\)/);
    if (!description && wdioAddValue) {
      description = `Type "${wdioAddValue[2]}" into element "${wdioAddValue[1]}"`;
    }

    // expect($('~id')).toBeDisplayed()
    const wdioAssertDisplayed = line.match(/expect\(\$\(['"]~(.*?)['"]\)\)\.toBeDisplayed/);
    if (!description && wdioAssertDisplayed) {
      description = `Assert element "${wdioAssertDisplayed[1]}" is visible`;
    }

    // driver.activateApp
    const activateApp = line.match(/driver\.activateApp\(['"](.+?)['"]\)/);
    if (!description && activateApp) {
      description = `Launch app "${activateApp[1]}"`;
    }

    // driver.pressKeyCode or driver.execute('mobile: pressButton'
    if (!description && (line.includes('pressKeyCode') || line.includes('pressButton'))) {
      description = 'Press key/button';
    }

    // driver.touchAction or driver.action('pointer')
    if (!description && (line.includes('touchAction') || line.includes("action('pointer')"))) {
      description = 'Tap on screen coordinates';
    }

    // ── Playwright patterns ──
    // page.goto
    const gotoMatch = line.match(/\.goto\(['"](.*?)['"]/);
    if (!description && gotoMatch) {
      description = `Navigate to "${gotoMatch[1]}"`;
    }

    // .click
    const clickMatch = line.match(/\.(?:get_by_role|getByRole)\(['"](.*?)['"],?\s*\{?\s*name:\s*['"](.*?)['"]/);
    if (!description && clickMatch) {
      description = `Click ${clickMatch[1]} "${clickMatch[2]}"`;
    }
    const clickLocatorMatch = line.match(/\.locator\(['"](.*?)['"]\)\.click/);
    if (!description && clickLocatorMatch) {
      description = `Click element "${clickLocatorMatch[1]}"`;
    }
    const clickGenericMatch = line.match(/\.click\(['"](.*?)['"]\)/);
    if (!description && clickGenericMatch) {
      description = `Click "${clickGenericMatch[1]}"`;
    }
    if (!description && line.includes('.click(')) {
      description = 'Click element';
    }

    // .fill / .type
    const fillMatch = line.match(/\.fill\(['"](.*?)['"],\s*['"](.*?)['"]\)/);
    if (!description && fillMatch) {
      description = `Fill "${fillMatch[1]}" with "${fillMatch[2]}"`;
    }
    const fillLocatorMatch = line.match(/\.locator\(['"](.*?)['"]\)\.fill\(['"](.*?)['"]\)/);
    if (!description && fillLocatorMatch) {
      description = `Fill element "${fillLocatorMatch[1]}" with "${fillLocatorMatch[2]}"`;
    }
    const getByLabelFill = line.match(/\.(?:get_by_label|getByLabel)\(['"](.*?)['"]\)\.fill\(['"](.*?)['"]\)/);
    if (!description && getByLabelFill) {
      description = `Fill label "${getByLabelFill[1]}" with "${getByLabelFill[2]}"`;
    }
    const getByPlaceholderFill = line.match(/\.(?:get_by_placeholder|getByPlaceholder)\(['"](.*?)['"]\)\.fill\(['"](.*?)['"]\)/);
    if (!description && getByPlaceholderFill) {
      description = `Fill placeholder "${getByPlaceholderFill[1]}" with "${getByPlaceholderFill[2]}"`;
    }

    // .press
    const pressMatch = line.match(/\.press\(['"](.*?)['"]\)/);
    if (!description && pressMatch) {
      description = `Press key "${pressMatch[1]}"`;
    }

    // .selectOption
    const selectMatch = line.match(/\.(?:select_option|selectOption)\(['"](.*?)['"]\)/);
    if (!description && selectMatch) {
      description = `Select option "${selectMatch[1]}"`;
    }

    // .check / .uncheck
    if (!description && line.includes('.check(')) {
      description = 'Check checkbox';
    }
    if (!description && line.includes('.uncheck(')) {
      description = 'Uncheck checkbox';
    }

    // .hover
    if (!description && line.includes('.hover(')) {
      description = 'Hover over element';
    }

    // .dblclick
    if (!description && line.includes('.dblclick(') || line.includes('.double_click(')) {
      description = 'Double-click element';
    }

    // assertions (expect)
    const expectVisibleMatch = line.match(/expect\(.*\)\..*(?:toBeVisible|to_be_visible)/);
    if (!description && expectVisibleMatch) {
      description = 'Assert element is visible';
    }
    const expectTextMatch = line.match(/expect\(.*\)\..*(?:toHaveText|to_have_text|toContainText|to_contain_text)\(['"](.*?)['"]\)/);
    if (!description && expectTextMatch) {
      description = `Assert text contains "${expectTextMatch[1]}"`;
    }

    // page.waitForURL / page.waitForSelector
    const waitURLMatch = line.match(/\.(?:waitForURL|wait_for_url)\(['"](.*?)['"]/);
    if (!description && waitURLMatch) {
      description = `Wait for URL "${waitURLMatch[1]}"`;
    }

    // getByText click
    const getByTextClick = line.match(/\.(?:get_by_text|getByText)\(['"](.*?)['"]\)\.click/);
    if (!description && getByTextClick) {
      description = `Click text "${getByTextClick[1]}"`;
    }

    // getByRole click (simpler pattern)
    const getByRoleClick = line.match(/\.(?:get_by_role|getByRole)\(['"](.*?)['"]\.*\)\.click/);
    if (!description && getByRoleClick) {
      description = `Click ${getByRoleClick[1]}`;
    }

    // page.close
    if (!description && (line.includes('page.close') || line.includes('browser.close') || line.includes('context.close'))) {
      description = 'Close browser';
    }

    // Fallback: if the line has an await and looks like an action
    if (!description && line.includes('await') && !line.includes('newPage') && !line.includes('newContext')) {
      const cleaned = line.replace(/await\s+/, '').replace(/;$/, '').trim();
      if (cleaned.length > 0 && cleaned.length < 120) {
        description = `Action: ${cleaned}`;
      }
    }

    if (description) {
      steps.push({ step: stepNum, description });
      stepNum++;
    }
  }

  return steps;
}

// ─── API: Start Recording ────────────────────────────────────────────────────
app.post('/api/record/start', async (req, res) => {
  if (activeProcess) {
    return res.status(409).json({
      success: false,
      message: 'A recording session is already active. Close the Playwright browser window first.',
    });
  }

  const { url, language, platform, appId } = req.body;
  const cfg = getConfig();
  const targetPlatform = platform || 'web';
  const targetUrl = url || cfg.targetUrl || 'https://www.enuygun.com/';

  const targetLang = language || 'javascript';
  lastRecordingUrl = targetPlatform === 'web' ? targetUrl : (appId || 'com.ismailaslan.flutterloginapp');
  lastRecordingLanguage = targetLang;
  lastRecordingPlatform = targetPlatform;

  // Clean up previous output file
  const outFile = getOutputFile();
  if (fs.existsSync(outFile)) {
    fs.unlinkSync(outFile);
  }

  // Ensure temp dir exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  processExited = false;
  processExitCode = null;
  processError = null;

  if (targetPlatform === 'android' || targetPlatform === 'ios') {
    // ── Mobile: Start Appium + WDIO Session ──
    try {
      await ensureAppiumRunning();
      const targetAppId = appId || 'com.ismailaslan.flutterloginapp';
      await createWdioSession(targetPlatform, targetAppId);

      // Write initial empty script
      const initialCode = `// 📱 Live Mobile Studio (${targetPlatform.toUpperCase()}) - WebdriverIO\n// App: ${targetAppId}\n\n`;
      fs.writeFileSync(getOutputFile(), initialCode, 'utf-8');

      processExited = true;
      processExitCode = 0;

      return res.json({
        success: true,
        mode: 'mobile-live',
        message: `Live Mobile Studio started for ${targetPlatform.toUpperCase()} via Appium + WebdriverIO!`,
      });
    } catch (err) {
      console.error('❌ Failed to start mobile session:', err.message);
      return res.status(500).json({
        success: false,
        message: `Failed to start mobile session: ${err.message}`,
      });
    }
  }

  // ── Web: Playwright Codegen ──
  const args = ['playwright', 'codegen', url, `--target=${targetLang}`, `--output=${getOutputFile()}`];

  console.log(`🎬 Starting recording: npx ${args.join(' ')}`);

  activeProcess = spawn('npx', args, {
    cwd: __dirname,
    stdio: 'pipe',
    shell: true,
  });

  activeProcess.stdout.on('data', (data) => {
    console.log(`[codegen stdout] ${data.toString().trim()}`);
  });

  activeProcess.stderr.on('data', (data) => {
    console.log(`[codegen stderr] ${data.toString().trim()}`);
  });

  activeProcess.on('error', (err) => {
    console.error('❌ Failed to start codegen process:', err.message);
    processError = err.message;
    processExited = true;
    cleanupProcess();
  });

  activeProcess.on('close', (code) => {
    console.log(`🛑 Codegen process exited with code ${code}`);
    processExitCode = code;
    processExited = true;
    cleanupProcess();
  });

  // 10-minute timeout safety net
  killTimeout = setTimeout(() => {
    if (activeProcess) {
      console.log('⏰ 10-minute timeout reached. Killing codegen process.');
      activeProcess.kill('SIGTERM');
    }
  }, MAX_EXECUTION_MS);

  return res.json({
    success: true,
    message: 'Recording started. The Playwright browser window should open on your desktop.',
  });
});

// ─── API: Recording Status ───────────────────────────────────────────────────
app.get('/api/record/status', (req, res) => {
  // Still recording
  if (activeProcess && !processExited) {
    return res.json({
      status: 'recording',
      message: 'Browser is still open. Execute your test actions, then close the browser window.',
    });
  }

  // Process exited
  if (processExited) {
    if (processError) {
      const errorMsg = processError;
      // Reset state for next recording
      processExited = false;
      processError = null;
      return res.json({
        status: 'error',
        message: `Recording failed: ${errorMsg}`,
      });
    }

    // Try to read the output file
    const outFile = getOutputFile();
    if (fs.existsSync(outFile)) {
      try {
        let code = fs.readFileSync(outFile, 'utf-8');
        // Automatically uncomment assertions generated as comments
        code = code.replace(/^\s*\/\/\s*(await\s+expect\(.*)/gm, '  $1');
        const steps = parseCodeToSteps(code, lastRecordingLanguage);

        return res.json({
          status: 'completed',
          message: 'Recording completed successfully.',
          data: {
            code,
            steps,
            url: lastRecordingUrl,
            language: lastRecordingLanguage,
            platform: lastRecordingPlatform,
          },
        });
      } catch (err) {
        return res.json({
          status: 'error',
          message: `Failed to read output file: ${err.message}`,
        });
      }
    } else {
      return res.json({
        status: 'completed',
        message: 'Recording completed but no actions were recorded.',
        data: {
          code: '// No actions were recorded.',
          steps: [],
          url: lastRecordingUrl,
          language: lastRecordingLanguage,
          platform: lastRecordingPlatform,
        },
      });
    }
  }

  // Idle state
  return res.json({
    status: 'idle',
    message: 'No active recording session.',
  });
});

// ─── API: Update Recorded/Edited Code ────────────────────────────────────────
app.post('/api/record/update-code', (req, res) => {
  const { code, language } = req.body;
  if (typeof code !== 'string') {
    return res.status(400).json({ success: false, message: 'Invalid code' });
  }
  const lang = language || lastRecordingLanguage || 'javascript';
  try {
    fs.writeFileSync(getOutputFile(), code, 'utf-8');
  } catch (_) { }
  const steps = parseCodeToSteps(code, lang);
  return res.json({
    success: true,
    data: {
      code,
      steps,
      url: lastRecordingUrl,
      language: lang,
      platform: lastRecordingPlatform,
    },
  });
});

// ─── API: Mobile Screenshot ──────────────────────────────────────────────────
app.get('/api/mobile/screenshot', async (req, res) => {
  try {
    if (!wdioSession) {
      return res.status(400).send('No active mobile session');
    }
    const base64 = await wdioSession.takeScreenshot();
    const imgBuffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.send(imgBuffer);
  } catch (e) {
    console.error('[Screenshot] Error:', e.message);
    return res.status(500).send('Screenshot failed: ' + e.message);
  }
});

// ─── API: Mobile Tap ─────────────────────────────────────────────────────────
app.post('/api/mobile/tap', async (req, res) => {
  const { normX, normY } = req.body;
  try {
    if (!wdioSession) {
      return res.status(400).json({ success: false, message: 'No active mobile session' });
    }

    // Get screen size from the session
    const windowSize = await wdioSession.getWindowSize();
    const devW = windowSize.width;
    const devH = windowSize.height;
    const tapX = Math.round(normX * devW);
    const tapY = Math.round(normY * devH);

    console.log(`[Tap] Click norm: (${normX.toFixed(3)}, ${normY.toFixed(3)}) calculated tap: (${tapX}, ${tapY}) screen size: ${devW}x${devH}`);

    // Get page source XML and find the element at the tap coordinates
    const pageSource = await wdioSession.getPageSource();
    console.log(`[Tap] Page source length: ${pageSource ? pageSource.length : 0}`);
    const bestElement = findElementAtCoords(pageSource, tapX, tapY, wdioSessionPlatform);

    // Always perform coordinate tap on the device to be fast and 100% reliable in the live studio
    await performCoordinateTap(wdioSession, tapX, tapY);

    let stepCode = '';
    if (bestElement && bestElement.selector) {
      console.log(`[Tap] Resolved selector: ${bestElement.selector}`);
      stepCode = `  await $('${bestElement.selector}').click();`;
    } else {
      console.log(`[Tap] No selector resolved, falling back to coordinate code`);
      stepCode = `  // Tap at coordinates (${tapX}, ${tapY})\n  await driver.action('pointer').move({ x: ${tapX}, y: ${tapY} }).down().up().perform();`;
    }

    // Append step to output file
    const outFile = getOutputFile();
    let currentCode = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : '';
    currentCode = currentCode.trimEnd() + '\n' + stepCode + '\n';
    fs.writeFileSync(outFile, currentCode, 'utf-8');
    const steps = parseCodeToSteps(currentCode, 'javascript');

    return res.json({ success: true, step: stepCode, data: { code: currentCode, steps, language: 'javascript' } });
  } catch (err) {
    console.error('[Tap] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Mobile Input Text ──────────────────────────────────────────────────
app.post('/api/mobile/input-text', async (req, res) => {
  const { text } = req.body;
  try {
    if (!wdioSession) {
      return res.status(400).json({ success: false, message: 'No active mobile session' });
    }

    // Find the focused/active element and type into it
    const activeEl = await wdioSession.getActiveElement();
    if (activeEl) {
      const elementId = activeEl.ELEMENT || activeEl['element-6066-11e4-a52e-4f735466cecf'];
      if (elementId) {
        await wdioSession.elementSendKeys(elementId, text);
      } else {
        await wdioSession.keys(text);
      }
    } else {
      // Fallback: use keyboard
      await wdioSession.keys(text);
    }

    // Find what element was focused to generate a better selector
    let stepCode = '';
    try {
      const pageSource = await wdioSession.getPageSource();
      const focusedSelector = findFocusedElementSelector(pageSource, wdioSessionPlatform);
      if (focusedSelector) {
        stepCode = `  await $('${focusedSelector}').setValue('${text.replace(/'/g, "\\'")}');`;
      } else {
        stepCode = `  await driver.keys('${text.replace(/'/g, "\\'")}');`;
      }
    } catch (_) {
      stepCode = `  await driver.keys('${text.replace(/'/g, "\\'")}');`;
    }

    const outFile = getOutputFile();
    let currentCode = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : '';
    currentCode = currentCode.trimEnd() + '\n' + stepCode + '\n';
    fs.writeFileSync(outFile, currentCode, 'utf-8');
    const steps = parseCodeToSteps(currentCode, 'javascript');

    return res.json({ success: true, data: { code: currentCode, steps, language: 'javascript' } });
  } catch (err) {
    console.error('[Input] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Mobile Key Press ───────────────────────────────────────────────────
app.post('/api/mobile/key', async (req, res) => {
  const { key } = req.body;
  try {
    if (!wdioSession) {
      return res.status(400).json({ success: false, message: 'No active mobile session' });
    }

    const keyMap = { 'ENTER': 66, 'BACK': 4, 'HOME': 3, 'TAB': 61, 'DELETE': 67 };

    if (wdioSessionPlatform === 'android') {
      const keyCode = keyMap[key.toUpperCase()] || 66;
      await wdioSession.pressKeyCode(keyCode);
    } else {
      // iOS
      if (key.toUpperCase() === 'ENTER') {
        await wdioSession.keys(['\n']);
      } else if (key.toUpperCase() === 'DELETE') {
        await wdioSession.keys(['\b']);
      } else {
        await wdioSession.execute('mobile: pressButton', { name: key.toLowerCase() });
      }
    }

    const keyName = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
    let stepCode;
    if (wdioSessionPlatform === 'android') {
      stepCode = `  await driver.pressKeyCode(${keyMap[key.toUpperCase()] || 66}); // ${keyName}`;
    } else {
      stepCode = `  await driver.execute('mobile: pressButton', { name: '${key.toLowerCase()}' }); // ${keyName}`;
    }

    const outFile = getOutputFile();
    let currentCode = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : '';
    currentCode = currentCode.trimEnd() + '\n' + stepCode + '\n';
    fs.writeFileSync(outFile, currentCode, 'utf-8');
    const steps = parseCodeToSteps(currentCode, 'javascript');

    return res.json({ success: true, data: { code: currentCode, steps, language: 'javascript' } });
  } catch (err) {
    console.error('[Key] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Mobile Assert Screen ───────────────────────────────────────────────
app.post('/api/mobile/assert-screen', async (req, res) => {
  const { normX, normY } = req.body;
  try {
    if (!wdioSession) {
      return res.status(400).json({ success: false, message: 'No active mobile session' });
    }

    const windowSize = await wdioSession.getWindowSize();
    const devW = windowSize.width;
    const devH = windowSize.height;
    const tapX = Math.round(normX * devW);
    const tapY = Math.round(normY * devH);

    const pageSource = await wdioSession.getPageSource();
    const bestElement = findElementAtCoords(pageSource, tapX, tapY, wdioSessionPlatform);

    if (!bestElement || !bestElement.selector) {
      return res.status(404).json({ success: false, message: 'No UI element found at clicked coordinate to assert.' });
    }

    const stepCode = `  await expect($('${bestElement.selector}')).toBeDisplayed();`;

    const outFile = getOutputFile();
    let currentCode = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : '';
    currentCode = currentCode.trimEnd() + '\n' + stepCode + '\n';
    fs.writeFileSync(outFile, currentCode, 'utf-8');
    const steps = parseCodeToSteps(currentCode, 'javascript');

    return res.json({ success: true, step: stepCode, data: { code: currentCode, steps, language: 'javascript' } });
  } catch (err) {
    console.error('[Assert] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Mobile Assert Custom ───────────────────────────────────────────────
app.post('/api/mobile/assert-custom', (req, res) => {
  const { type, value } = req.body;
  if (!value || !value.trim()) {
    return res.status(400).json({ success: false, message: 'Assertion value is required' });
  }
  const val = value.trim().replace(/'/g, "\\'");
  let stepCode = '';
  if (type === 'visible-id') {
    stepCode = `  await expect($('~${val}')).toBeDisplayed();`;
  } else if (type === 'visible-text') {
    stepCode = `  await expect($('//*[@text="${val}"]')).toBeDisplayed();`;
  } else if (type === 'not-visible-id') {
    stepCode = `  await expect($('~${val}')).not.toBeDisplayed();`;
  } else if (type === 'not-visible-text') {
    stepCode = `  await expect($('//*[@text="${val}"]')).not.toBeDisplayed();`;
  } else {
    stepCode = `  await expect($('~${val}')).toBeDisplayed();`;
  }

  const outFile = getOutputFile();
  let currentCode = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : '';
  currentCode = currentCode.trimEnd() + '\n' + stepCode + '\n';
  fs.writeFileSync(outFile, currentCode, 'utf-8');
  const steps = parseCodeToSteps(currentCode, 'javascript');
  return res.json({ success: true, step: stepCode, data: { code: currentCode, steps, language: 'javascript' } });
});

// ─── API: Stop Mobile Session ────────────────────────────────────────────────
app.post('/api/mobile/stop', async (req, res) => {
  await destroyWdioSession();
  return res.json({ success: true, message: 'Mobile session stopped.' });
});

// ─── Helper: Find element at coordinates from page source XML ────────────────
function findElementAtCoords(xmlSource, tapX, tapY, platform) {
  // Parse bounds from XML elements
  const regex = /<[^/][^>]*\s(bounds="[^"]*"|x="[^"]*"\s+y="[^"]*"\s+width="[^"]*"\s+height="[^"]*")[^>]*>/g;
  let match;
  let bestNode = null;
  let smallestArea = Infinity;

  if (platform === 'ios') {
    // iOS XCUITest XML format: x, y, width, height attributes
    const iosRegex = /<([A-Z][A-Za-z]*)\s+([^>]*)\/?>(?:<\/\1>)?/g;
    while ((match = iosRegex.exec(xmlSource)) !== null) {
      const tag = match[1];
      const attrStr = match[2];

      const xM = attrStr.match(/\bx="(\d+)"/);
      const yM = attrStr.match(/\by="(\d+)"/);
      const wM = attrStr.match(/\bwidth="(\d+)"/);
      const hM = attrStr.match(/\bheight="(\d+)"/);
      if (!xM || !yM || !wM || !hM) continue;

      const left = parseInt(xM[1]);
      const top = parseInt(yM[1]);
      const width = parseInt(wM[1]);
      const height = parseInt(hM[1]);
      const right = left + width;
      const bottom = top + height;
      const area = width * height;

      if (tapX >= left && tapX <= right && tapY >= top && tapY <= bottom && area > 0 && area < smallestArea) {
        const nameM = attrStr.match(/\bname="([^"]*)"/);
        const labelM = attrStr.match(/\blabel="([^"]*)"/);
        const valueM = attrStr.match(/\bvalue="([^"]*)"/);

        const name = nameM ? nameM[1] : '';
        const label = labelM ? labelM[1] : '';

        let selector = '';
        if (name) {
          selector = `~${name}`;
        } else if (label && label.length < 50) {
          selector = `~${label}`;
        }

        if (selector || name || label) {
          bestNode = { selector, text: label || name, tag, area };
          smallestArea = area;
        }
      }
    }
  } else {
    // Android UiAutomator2 XML format: bounds="[left,top][right,bottom]"
    const androidRegex = /<([a-zA-Z0-9._-]+)\s+([^>]+)\/?>/g;
    while ((match = androidRegex.exec(xmlSource)) !== null) {
      const attrStr = match[2];
      const boundsMatch = attrStr.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!boundsMatch) continue;

      const left = parseInt(boundsMatch[1], 10);
      const top = parseInt(boundsMatch[2], 10);
      const right = parseInt(boundsMatch[3], 10);
      const bottom = parseInt(boundsMatch[4], 10);
      const area = (right - left) * (bottom - top);

      if (tapX >= left && tapX <= right && tapY >= top && tapY <= bottom && area > 0 && area < smallestArea) {
        const textMatch = attrStr.match(/text="([^"]*)"/);
        const idMatch = attrStr.match(/resource-id="([^"]*)"/);
        const descMatch = attrStr.match(/content-desc="([^"]*)"/);

        const text = textMatch ? textMatch[1] : '';
        const resourceId = idMatch ? idMatch[1] : '';
        const contentDesc = descMatch ? descMatch[1] : '';

        console.log(`[findElementAtCoords] Candidate: bounds=[${left},${top}][${right},${bottom}] area=${area} resource-id="${resourceId}" content-desc="${contentDesc}" text="${text}"`);

        let selector = '';
        if (contentDesc) {
          selector = `~${contentDesc}`;
        } else if (resourceId && !resourceId.includes('android:id')) {
          let resId = resourceId;
          if (resId.includes(':id/')) resId = resId.split(':id/')[1];
          selector = `//*[contains(@resource-id, "${resId}")]`;
        } else if (text && text.length < 50) {
          selector = `//*[@text="${text}"]`;
        }

        if (selector || text || resourceId || contentDesc) {
          bestNode = { selector, text: contentDesc || text, resourceId, area };
          smallestArea = area;
        }
      }
    }
  }

  return bestNode;
}

function findFocusedElementSelector(xmlSource, platform) {
  if (platform === 'android') {
    const focusedMatch = xmlSource.match(/<[a-zA-Z0-9._-]+\s+[^>]*focused="true"[^>]*>/);
    if (focusedMatch) {
      const attrStr = focusedMatch[0];
      const descMatch = attrStr.match(/content-desc="([^"]+)"/);
      const idMatch = attrStr.match(/resource-id="([^"]+)"/);
      if (descMatch) return `~${descMatch[1]}`;
      if (idMatch) {
        let resId = idMatch[1];
        if (resId.includes(':id/')) resId = resId.split(':id/')[1];
        return `//*[contains(@resource-id, "${resId}")]`;
      }
    }
  }
  return null;
}

async function performCoordinateTap(session, x, y) {
  await session.action('pointer', {
    parameters: { pointerType: 'touch' },
  })
    .move({ x, y, origin: 'viewport' })
    .down()
    .up()
    .perform();
}

// ─── API: Save Test Case ─────────────────────────────────────────────────────
app.post('/api/test-cases', async (req, res) => {
  let { name, url, language, code, steps, platform, app_id } = req.body;

  if (!name || !code) {
    return res.status(400).json({ success: false, message: 'Name and code are required.' });
  }

  // Ensure any commented-out assertions from Codegen are uncommented and active
  if (typeof code === 'string') {
    code = code.replace(/^\s*\/\/\s*(await\s+expect\(.*)/gm, '  $1');
  }
  // Ensure steps reflect the active assertions
  if (!steps || steps.length === 0 || steps.some(s => typeof s.description === 'string' && s.description.startsWith('//'))) {
    steps = parseCodeToSteps(code, language);
  }

  try {
    const result = await pool.query(
      `INSERT INTO test_cases (name, url, language, code, steps, platform, app_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, url || '', language || 'javascript', code, JSON.stringify(steps || []), platform || 'web', app_id || '']
    );
    return res.json({ success: true, testCase: result.rows[0] });
  } catch (err) {
    console.error('❌ Failed to save test case:', err.message);
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// ─── API: Get All Test Cases ─────────────────────────────────────────────────
app.get('/api/test-cases', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM test_cases ORDER BY created_at DESC');
    return res.json({ success: true, testCases: result.rows });
  } catch (err) {
    console.error('❌ Failed to fetch test cases:', err.message);
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// ─── API: Delete Test Case ───────────────────────────────────────────────────
app.delete('/api/test-cases/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM test_cases WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Failed to delete test case:', err.message);
    return res.status(500).json({ success: false, message: `Database error: ${err.message}` });
  }
});

// ─── API: Run Test Case ──────────────────────────────────────────────────────
app.post('/api/test-cases/:id/run', async (req, res) => {
  if (runnerProcess) {
    return res.status(409).json({
      success: false,
      message: 'A test is already running. Please wait for it to finish.',
    });
  }

  const testId = parseInt(req.params.id, 10);

  try {
    const result = await pool.query('SELECT * FROM test_cases WHERE id = $1', [testId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Test case not found.' });
    }

    const tc = result.rows[0];
    const tcPlatform = tc.platform || 'web';

    // Prepare report directory
    const reportDir = path.join(REPORTS_DIR, `test-${testId}`);
    if (fs.existsSync(reportDir)) {
      fs.rmSync(reportDir, { recursive: true, force: true });
    }
    fs.mkdirSync(reportDir, { recursive: true });

    // Reset runner state
    runnerState = 'running';
    runnerTestId = testId;
    runnerOutput = '';
    runnerReportPath = `/reports/test-${testId}/index.html`;

    if (tcPlatform === 'android' || tcPlatform === 'ios') {
      // ── Mobile: Run with WDIO ──
      const wdioTestCode = convertToWdioTest(tc.code, tc.name, tcPlatform, tc.app_id || tc.url);
      const testFile = path.join(__dirname, `run_test_${testId}.wdio.js`);
      fs.writeFileSync(testFile, wdioTestCode, 'utf-8');

      // Generate WDIO config for this test
      const wdioConfigFile = path.join(__dirname, `wdio_run_${testId}.conf.js`);
      const wdioConfigContent = generateWdioConfig(testFile, tcPlatform, tc.app_id || tc.url, reportDir);
      fs.writeFileSync(wdioConfigFile, wdioConfigContent, 'utf-8');

      console.log(`▶️  Running mobile test #${testId} (${tcPlatform}): "${tc.name}"`);

      // Ensure Appium is running
      await ensureAppiumRunning();

      const args = ['wdio', 'run', wdioConfigFile];
      runnerProcess = spawn('npx', args, {
        cwd: __dirname,
        stdio: 'pipe',
        shell: true,
      });

      runnerProcess.stdout.on('data', (data) => {
        const text = data.toString();
        runnerOutput += text;
        console.log(`[wdio stdout] ${text.trim()}`);
      });

      runnerProcess.stderr.on('data', (data) => {
        const text = data.toString();
        runnerOutput += text;
        console.log(`[wdio stderr] ${text.trim()}`);
      });

      runnerProcess.on('error', (err) => {
        console.error('❌ WDIO runner error:', err.message);
        runnerState = 'error';
        runnerOutput += `\nError: ${err.message}`;
        runnerProcess = null;
      });

      runnerProcess.on('close', (code) => {
        console.log(`🏁 Mobile Test #${testId} finished with exit code ${code}`);
        runnerState = 'completed';
        runnerProcess = null;

        // Generate a simple HTML report
        generateMobileReport(reportDir, tc, runnerOutput, code);

        // Clean up temporary files
        try { fs.unlinkSync(testFile); } catch (_) { }
        try { fs.unlinkSync(wdioConfigFile); } catch (_) { }
      });

      return res.json({
        success: true,
        message: `Mobile test "${tc.name}" is now running via WebdriverIO...`,
      });
    } else {
      // ── Web: Playwright Test ──
      const language = tc.language || 'javascript';
      if (!['javascript', 'playwright-test'].includes(language)) {
        runnerState = 'idle';
        return res.status(400).json({
          success: false,
          message: `Running ${language} tests is not supported yet. Only JavaScript tests can be run.`,
        });
      }

      const testCode = convertToPlaywrightTest(tc.code, tc.name);

      const testFile = path.join(__dirname, `run_test_${testId}.spec.js`);
      fs.writeFileSync(testFile, testCode, 'utf-8');

      const cfg = getConfig();
      const configFile = path.join(__dirname, `playwright_run_${testId}.config.js`);
      const configContent = `
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  reporter: [['html', { outputFolder: '${reportDir.replace(/\\/g, '/')}', open: 'never' }]],
  use: {
    headless: false,
    baseURL: '${tc.url || cfg.targetUrl || 'https://www.enuygun.com/'}',
  },
});
`;
      fs.writeFileSync(configFile, configContent, 'utf-8');

      console.log(`▶️  Running web test #${testId}: "${tc.name}"`);

      const args = ['playwright', 'test', testFile, `--config=${configFile}`];
      runnerProcess = spawn('npx', args, {
        cwd: __dirname,
        stdio: 'pipe',
        shell: true,
      });

      runnerProcess.stdout.on('data', (data) => {
        const text = data.toString();
        runnerOutput += text;
        console.log(`[test stdout] ${text.trim()}`);
      });

      runnerProcess.stderr.on('data', (data) => {
        const text = data.toString();
        runnerOutput += text;
        console.log(`[test stderr] ${text.trim()}`);
      });

      runnerProcess.on('error', (err) => {
        console.error('❌ Test runner error:', err.message);
        runnerState = 'error';
        runnerOutput += `\nError: ${err.message}`;
        runnerProcess = null;
      });

      runnerProcess.on('close', (code) => {
        console.log(`🏁 Test #${testId} finished with exit code ${code}`);
        runnerState = 'completed';
        runnerProcess = null;

        try { fs.unlinkSync(testFile); } catch (_) { }
        try { fs.unlinkSync(configFile); } catch (_) { }
      });

      return res.json({
        success: true,
        message: `Test "${tc.name}" is now running...`,
      });
    }
  } catch (err) {
    console.error('❌ Failed to run test:', err.message);
    runnerState = 'idle';
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── API: Run Status ─────────────────────────────────────────────────────────
app.get('/api/test-cases/run-status', (req, res) => {
  if (runnerState === 'idle') {
    return res.json({ status: 'idle' });
  }

  if (runnerState === 'running') {
    return res.json({ status: 'running', testId: runnerTestId });
  }

  // completed or error — return result then reset
  const result = {
    status: runnerState,
    testId: runnerTestId,
    reportUrl: runnerReportPath,
    output: runnerOutput,
  };

  // Reset for next run
  runnerState = 'idle';
  runnerTestId = null;
  runnerOutput = '';
  runnerReportPath = null;

  return res.json(result);
});

// ─── Helper: Convert standalone codegen to Playwright Test format ────────────
function convertToPlaywrightTest(code, testName) {
  if (code && typeof code === 'string') {
    code = code.replace(/^\s*\/\/\s*(await\s+expect\(.*)/gm, '  $1');
  }

  if (code.includes("test(") || code.includes("test.describe(")) {
    return code;
  }

  const lines = code.split('\n');
  const bodyLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    const isPageAction = trimmed.startsWith('await page.');
    const isExpect = trimmed.startsWith('await expect(') || trimmed.startsWith('expect(');
    const isComment = trimmed.startsWith('//');
    const isEmptyLine = trimmed === '';

    if (isPageAction || isExpect) {
      bodyLines.push(`  ${trimmed}`);
    } else if (isComment && bodyLines.length > 0) {
      bodyLines.push(`  ${trimmed}`);
    } else if (isEmptyLine && bodyLines.length > 0) {
      bodyLines.push('');
    }
  }

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }

  const safeName = testName.replace(/'/g, "\\'");
  let body = bodyLines.join('\n');
  body = body.replace(/goto\(['"]https?:\/\/[^'"]+['"]\)/g, "goto('/')");

  return `const { test, expect } = require('@playwright/test');

test('${safeName}', async ({ page }) => {
${body}
});
`;
}

function convertToWdioTest(code, testName, platform, appId) {
  const targetAppId = appId || 'com.ismailaslan.flutter_login_app';
  const cleanStart = `    // Clean launch the app: terminate first if running, then activate
    try { await driver.terminateApp('${targetAppId}'); } catch (_) {}
    await driver.activateApp('${targetAppId}');
    await driver.pause(3000);`;

  const lines = code.split('\n');
  const bodyLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for click followed by keys
    if (trimmed.startsWith('await $(') && (trimmed.endsWith(').click();') || trimmed.endsWith(').click()'))) {
      let foundKeys = false;
      let keysText = '';
      let keysIndex = -1;

      for (let j = i + 1; j < lines.length; j++) {
        const nextTrimmed = lines[j].trim();
        if (!nextTrimmed) continue;
        if (nextTrimmed.startsWith('await driver.keys(')) {
          const match = nextTrimmed.match(/await driver\.keys\(['"](.*)['"]\)/);
          if (match) {
            keysText = match[1];
            foundKeys = true;
            keysIndex = j;
          }
          break;
        } else if (nextTrimmed.startsWith('//') || nextTrimmed.startsWith('await driver.pause(')) {
          continue;
        } else {
          break;
        }
      }

      if (foundKeys) {
        const selectorMatch = trimmed.match(/await \$\((['"`].*?['"`])\)/);
        if (selectorMatch) {
          const selectorStr = selectorMatch[1];
          bodyLines.push(`    await $(${selectorStr}).setValue('${keysText}');`);
          lines[keysIndex] = ''; // skip this line
          continue;
        }
      }
    }

    if (trimmed.startsWith('await ') || trimmed.startsWith('expect(') || trimmed.startsWith('await expect(')) {
      bodyLines.push(`    ${trimmed}`);
    } else if (trimmed.startsWith('//') && bodyLines.length > 0) {
      bodyLines.push(`    ${trimmed}`);
    }
  }

  const safeName = testName.replace(/'/g, "\\'");
  return `describe('${safeName}', () => {
  it('should execute mobile test', async () => {
${cleanStart}

${bodyLines.join('\n')}
  });
});
`;
}

// ─── Helper: Generate WDIO config for test execution ─────────────────────────
function generateWdioConfig(testFile, platform, appId, reportDir) {
  const isAndroid = platform === 'android';
  let capabilities;

  if (isAndroid) {
    capabilities = `{
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:appPackage': '${appId || 'com.ismailaslan.flutterloginapp'}',
      'appium:appActivity': '${appId || 'com.ismailaslan.flutterloginapp'}.MainActivity',
      'appium:noReset': true,
      'appium:newCommandTimeout': 300,
    }`;
  } else {
    const udid = getBootedSimulatorUDID();
    capabilities = `{
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:bundleId': '${appId || 'com.ismailaslan.flutterloginapp'}',
      'appium:noReset': true,
      'appium:newCommandTimeout': 300,
      ${udid !== 'booted' ? `'appium:udid': '${udid}',` : ''}
    }`;
  }

  return `exports.config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  specs: ['./${path.basename(testFile)}'],
  maxInstances: 1,
  capabilities: [${capabilities}],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },
  reporters: ['spec'],
  logLevel: 'warn',
  waitforTimeout: 10000,
  connectionRetryTimeout: 60000,
  connectionRetryCount: 3,
};
`;
}

// ─── Helper: Generate mobile HTML report ─────────────────────────────────────
function generateMobileReport(reportDir, tc, output, exitCode) {
  const passed = exitCode === 0;
  const statusBadge = passed ? '<span style="background:#10b981;color:#fff;padding:4px 12px;border-radius:99px;font-weight:bold;font-size:14px;">PASSED</span>' : '<span style="background:#ef4444;color:#fff;padding:4px 12px;border-radius:99px;font-weight:bold;font-size:14px;">FAILED</span>';
  const steps = Array.isArray(tc.steps) ? tc.steps : [];

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mobile Test Report - ${escapeHtml(tc.name)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; max-width: 900px; margin: 0 auto; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    .step { background: #0f172a; border-left: 4px solid ${passed ? '#38bdf8' : '#ef4444'}; padding: 12px 16px; margin: 12px 0; border-radius: 0 8px 8px 0; font-family: monospace; font-size: 13px; }
    pre { background: #0f172a; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 12px; line-height: 1.5; border: 1px solid #334155; }
    h1 { margin: 0; font-size: 24px; }
    h3 { color: #94a3b8; margin-top: 24px; }
    hr { border: 0; border-top: 1px solid #334155; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h1>📱 ${(tc.platform || 'Mobile').toUpperCase()} Test Report</h1>
      ${statusBadge}
    </div>
    <p style="color: #94a3b8;">Test: <strong>${escapeHtml(tc.name)}</strong> | App: <strong>${escapeHtml(tc.app_id || tc.url || 'N/A')}</strong> | Engine: <strong>Appium + WebdriverIO</strong></p>
    <hr>
    <h3>Test Steps:</h3>
    ${steps.map(s => `<div class="step">${passed ? '✅' : '❌'} Step ${s.step}: ${escapeHtml(s.description)}</div>`).join('') || '<div class="step">No steps recorded.</div>'}
    <h3>Console Output:</h3>
    <pre>${escapeHtml(output || 'No output captured.')}</pre>
    <p style="margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">Generated by Playwright Codegen Studio (Appium + WebdriverIO)</p>
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(reportDir, 'index.html'), html, 'utf-8');
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       🎭 Playwright Codegen Studio                  ║');
  console.log('║       Running on http://localhost:' + PORT + '              ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  await initDatabase();
});
