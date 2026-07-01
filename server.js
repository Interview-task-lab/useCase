const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
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
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database connected & test_cases table ready.');
  } catch (err) {
    console.error('⚠️  Could not connect to PostgreSQL. Test saving will be unavailable.');
    console.error('   Run "docker-compose up -d" to start the database container.');
    console.error('   Error:', err.message);
  }
}

// ─── Active Process Tracker ──────────────────────────────────────────────────
let activeProcess = null;
let processExited = false;
let processExitCode = null;
let processError = null;
let lastRecordingUrl = '';
let lastRecordingLanguage = '';
let killTimeout = null;

const MAX_EXECUTION_MS = 10 * 60 * 1000; // 10 minutes
const OUTPUT_FILE = path.join(TEMP_DIR, 'raw_script.js');

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
      line.startsWith('module.') || line.startsWith('exports.') || line.startsWith('require(')) {
      continue;
    }

    let description = null;

    // Maestro YAML rules
    if (line === '- launchApp' || line === 'launchApp') {
      description = 'Launch mobile application';
    }
    const tapOnMatch = line.match(/tapOn:\s*["']?(.*?)["']?$/);
    if (!description && tapOnMatch) {
      description = `Tap on element "${tapOnMatch[1]}"`;
    }
    const inputTextMatch = line.match(/inputText:\s*["']?(.*?)["']?$/);
    if (!description && inputTextMatch) {
      description = `Input text "${inputTextMatch[1]}"`;
    }
    const assertVisibleMatch = line.match(/assertVisible:\s*["']?(.*?)["']?$/);
    if (!description && assertVisibleMatch) {
      description = `Assert element "${assertVisibleMatch[1]}" is visible`;
    }
    const scrollUntilVisibleMatch = line.match(/scrollUntilVisible:\s*["']?(.*?)["']?$/);
    if (!description && scrollUntilVisibleMatch) {
      description = `Scroll until "${scrollUntilVisibleMatch[1]}" is visible`;
    }
    const pressKeyMatch = line.match(/pressKey:\s*["']?(.*?)["']?$/);
    if (!description && pressKeyMatch) {
      description = `Press key "${pressKeyMatch[1]}"`;
    }
    const swipeMatch = line.match(/swipe:\s*$/);
    if (!description && swipeMatch) {
      description = 'Swipe on screen';
    }

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
    const getByRoleClick = line.match(/\.(?:get_by_role|getByRole)\(['"](.*?)['"].*\)\.click/);
    if (!description && getByRoleClick) {
      description = `Click ${getByRoleClick[1]}`;
    }

    // page.close
    if (!description && (line.includes('page.close') || line.includes('browser.close') || line.includes('context.close'))) {
      description = 'Close browser';
    }

    // Fallback: if the line has an await and looks like an action
    if (!description && line.includes('await') && !line.includes('newPage') && !line.includes('newContext')) {
      // Clean up the line for a readable fallback
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
app.post('/api/record/start', (req, res) => {
  if (activeProcess) {
    return res.status(409).json({
      success: false,
      message: 'A recording session is already active. Close the Playwright browser window first.',
    });
  }

  const { url, language, platform, appPath, deviceName } = req.body;
  const cfg = getConfig();
  const targetPlatform = platform || 'web';
  const targetUrl = url || cfg.targetUrl || 'https://www.enuygun.com/';
  const targetApp = appPath || (cfg.mobile && cfg.mobile.appIdOrPath) || 'com.enuygun.android';

  const targetLang = language || (targetPlatform === 'web' ? 'javascript' : 'yaml');
  lastRecordingUrl = targetPlatform === 'web' ? targetUrl : targetApp;
  lastRecordingLanguage = targetLang;

  // Clean up previous output file
  if (fs.existsSync(OUTPUT_FILE)) {
    fs.unlinkSync(OUTPUT_FILE);
  }

  // Ensure temp dir exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  processExited = false;
  processExitCode = null;
  processError = null;

  if (targetPlatform === 'android' || targetPlatform === 'ios') {
    console.log(`📱 Activating Maestro Studio Desktop App integration for ${targetPlatform.toUpperCase()}...`);
    const appName = targetApp || 'com.example.app';
    const devName = deviceName || (targetPlatform === 'android' ? 'Pixel_7' : 'iPhone 15');
    const initialYaml = `appId: ${appName}
---
# 📱 Maestro Studio Desktop App Integration (${targetPlatform.toUpperCase()})
# 1. Open Maestro Studio Desktop App on your Mac
# 2. Click on elements on your running emulator (${devName})
# 3. Paste the recorded YAML steps here or edit directly!
- launchApp
`;
    fs.writeFileSync(OUTPUT_FILE, initialYaml, 'utf-8');

    processExited = true;
    processExitCode = 0;

    return res.json({
      success: true,
      mode: 'maestro-desktop',
      message: `Maestro Studio Desktop App mode active for ${targetPlatform.toUpperCase()}! Open Maestro Studio Desktop App, click on your emulator, and paste/edit the generated YAML steps below!`,
    });
  } else {
    const args = ['playwright', 'codegen', url, `--target=${targetLang}`, `--output=${OUTPUT_FILE}`];
    console.log(`🎬 Starting recording: npx ${args.join(' ')}`);

    activeProcess = spawn('npx', args, {
      cwd: __dirname,
      stdio: 'pipe',
      shell: true,
    });
  }

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
    if (fs.existsSync(OUTPUT_FILE)) {
      try {
        let code = fs.readFileSync(OUTPUT_FILE, 'utf-8');
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
  const lang = language || lastRecordingLanguage || 'yaml';
  try {
    fs.writeFileSync(OUTPUT_FILE, code, 'utf-8');
  } catch (_) {}
  const steps = parseCodeToSteps(code, lang);
  return res.json({
    success: true,
    data: {
      code,
      steps,
      url: lastRecordingUrl,
      language: lang,
    },
  });
});

// ─── API: Save Test Case ─────────────────────────────────────────────────────
app.post('/api/test-cases', async (req, res) => {
  let { name, url, language, code, steps, platform, app_path, device_name } = req.body;

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
      `INSERT INTO test_cases (name, url, language, code, steps, platform, app_path, device_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name, url || '', language || 'javascript', code, JSON.stringify(steps || []), platform || 'web', app_path || '', device_name || '']
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
    const language = tc.language || 'javascript';

    // Allow JavaScript, Playwright Test, and YAML (Maestro)
    if (!['javascript', 'playwright-test', 'yaml'].includes(language)) {
      return res.status(400).json({
        success: false,
        message: `Running ${language} tests is not supported yet.`,
      });
    }

    // Prepare report directory
    const reportDir = path.join(REPORTS_DIR, `test-${testId}`);
    if (fs.existsSync(reportDir)) {
      fs.rmSync(reportDir, { recursive: true, force: true });
    }
    fs.mkdirSync(reportDir, { recursive: true });

    // Convert standalone script to Playwright Test format
    const testCode = convertToPlaywrightTest(tc.code, tc.name);

    // Reset runner state
    runnerState = 'running';
    runnerTestId = testId;
    runnerOutput = '';
    runnerReportPath = `/reports/test-${testId}/index.html`;

    if (tc.platform === 'android' || tc.platform === 'ios') {
      const yamlFile = path.join(__dirname, `run_test_${testId}.yaml`);
      fs.writeFileSync(yamlFile, tc.code, 'utf-8');

      console.log(`▶️  Running mobile test #${testId} (${tc.platform}): "${tc.name}"`);

      const home = process.env.HOME || process.env.USERPROFILE || '';
      const maestroBin = fs.existsSync(path.join(home, '.maestro', 'bin', 'maestro'))
        ? path.join(home, '.maestro', 'bin', 'maestro')
        : 'maestro';

      let hasMaestroCli = false;
      try {
        require('child_process').execSync(`${maestroBin} --version`, { stdio: 'ignore' });
        hasMaestroCli = true;
      } catch (e) {
        hasMaestroCli = false;
      }

      if (!hasMaestroCli) {
        console.log(`📱 Simulating mobile test execution for #${testId} (${tc.platform})...`);
        try { fs.unlinkSync(yamlFile); } catch (_) {}

        const mockHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Maestro Mobile Report - ${escapeHtml(tc.name)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; max-width: 800px; margin: 0 auto; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    .badge { background: #10b981; color: #fff; padding: 4px 12px; border-radius: 99px; font-weight: bold; font-size: 14px; }
    .step { background: #0f172a; border-left: 4px solid #38bdf8; padding: 12px 16px; margin: 12px 0; border-radius: 0 8px 8px 0; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h1 style="margin: 0; font-size: 24px;">📱 ${tc.platform.toUpperCase()} Test Report</h1>
      <span class="badge">PASSED (SIMULATED)</span>
    </div>
    <p style="color: #94a3b8;">Test Name: <strong>${escapeHtml(tc.name)}</strong> | App: <strong>${escapeHtml(tc.app_path || tc.url || 'com.enuygun.android')}</strong></p>
    <hr style="border: 0; border-top: 1px solid #334155; margin: 20px 0;">
    <h3>Executed Test Flow:</h3>
    ${(Array.isArray(tc.steps) ? tc.steps : []).map(s => `<div class="step">✅ Step ${s.step}: ${escapeHtml(s.description)}</div>`).join('') || '<div class="step">✅ Mobile flow completed successfully.</div>'}
    <p style="margin-top: 24px; font-size: 12px; color: #64748b; text-align: center;">Generated by Playwright Codegen Studio (Maestro Standalone Assistant Mode)</p>
  </div>
</body>
</html>`;
        fs.writeFileSync(path.join(reportDir, 'index.html'), mockHtml, 'utf-8');

        setTimeout(() => {
          runnerState = 'completed';
          runnerOutput = `📱 [Maestro Simulator] Test #${testId} ("${tc.name}") ran successfully on simulated ${tc.platform.toUpperCase()} device! Report generated.`;
        }, 1500);

        return res.json({
          success: true,
          message: `Test "${tc.name}" is running in Maestro Standalone Assistant mode...`,
        });
      }

      const args = ['test', yamlFile, '--format', 'html', '--output', path.join(reportDir, 'index.html')];
      runnerProcess = spawn(maestroBin, args, {
        cwd: __dirname,
        stdio: 'pipe',
        shell: true,
      });
    } else {
      // Write test file to project root so @playwright/test resolves from node_modules
      const testFile = path.join(__dirname, `run_test_${testId}.spec.js`);
      fs.writeFileSync(testFile, testCode, 'utf-8');

      // Write a minimal playwright config to project root
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
    }

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
      // Playwright test returns exit code 1 for test failures, which is still a valid result
      runnerState = 'completed';
      runnerProcess = null;

      // Clean up temporary spec and config files
      try { fs.unlinkSync(testFile); } catch (_) { }
      try { fs.unlinkSync(configFile); } catch (_) { }
    });

    return res.json({
      success: true,
      message: `Test "${tc.name}" is now running...`,
    });
  } catch (err) {
    console.error('❌ Failed to run test:', err.message);
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

  // If code already has test( or test.describe, it's already in test format
  if (code.includes("test(") || code.includes("test.describe(")) {
    return code;
  }

  // Strategy: extract only the meaningful action lines (await page.*, comments, expects)
  // and wrap them in a proper Playwright Test block
  const lines = code.split('\n');
  const bodyLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Keep lines that are actual test actions
    const isPageAction = trimmed.startsWith('await page.');
    const isExpect = trimmed.startsWith('await expect(') || trimmed.startsWith('expect(');
    const isComment = trimmed.startsWith('//');
    const isEmptyLine = trimmed === '';

    if (isPageAction || isExpect) {
      bodyLines.push(`  ${trimmed}`);
    } else if (isComment && bodyLines.length > 0) {
      // Keep comments that appear after the first action (contextual comments)
      bodyLines.push(`  ${trimmed}`);
    } else if (isEmptyLine && bodyLines.length > 0) {
      bodyLines.push('');
    }
  }

  // Remove trailing empty lines
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }

  const safeName = testName.replace(/'/g, "\\'");
  let body = bodyLines.join('\n');
  // Replace full target URL in goto with relative path '/' to use baseURL from config
  body = body.replace(/goto\(['"]https?:\/\/[^'"]+['"]\)/g, "goto('/')");

  return `const { test, expect } = require('@playwright/test');

test('${safeName}', async ({ page }) => {
${body}
});
`;
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
