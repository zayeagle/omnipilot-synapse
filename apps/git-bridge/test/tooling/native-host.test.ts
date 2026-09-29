import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_BROWSERS,
  HOST_NAME,
  assertInsideRoot,
  companionPathCandidates,
  installPlan,
  nativeMessagingDir,
  parseInstallArgs,
  renderManifest,
} from '../../native-host/install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..', '..');
const installScript = join(packageDir, 'native-host', 'install.mjs');
const template = JSON.parse(
  readFileSync(join(packageDir, 'native-host', 'manifest.template.json'), 'utf8'),
);
const values = {
  COMPANION_PATH: '/opt/omni/git-bridge.mjs',
  CHROME_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop',
  FIREFOX_EXTENSION_ID: 'synapse@omnipilot.dev',
};

describe('native-host manifest template', () => {
  it('names the exact host the extension connects to', () => {
    expect(HOST_NAME).toBe('com.omnipilot.synapse.git_bridge');
    expect(template.name).toBe(HOST_NAME);
  });

  it('carries allowed_origins for Chromium and allowed_extensions for Firefox', () => {
    expect(template.targets.chrome.allowed_origins).toEqual([
      'chrome-extension://${CHROME_EXTENSION_ID}/',
    ]);
    expect(template.targets.firefox.allowed_extensions).toEqual(['${FIREFOX_EXTENSION_ID}']);
    expect(template.targets.chrome.allowed_extensions).toBeUndefined();
    expect(template.targets.firefox.allowed_origins).toBeUndefined();
  });

  it('points at the companion entry point through the absolute-path placeholder', () => {
    expect(template.targets.chrome.path).toBe('${COMPANION_PATH}');
    expect(template.targets.firefox.path).toBe('${COMPANION_PATH}');
    expect(template.targets.chrome.type).toBe('stdio');
    expect(template.targets.firefox.type).toBe('stdio');
  });
});

describe('renderManifest', () => {
  it('fills every placeholder for the requested target', () => {
    expect(renderManifest(template, 'chrome', values)).toEqual({
      name: HOST_NAME,
      description: template.description,
      type: 'stdio',
      path: values.COMPANION_PATH,
      allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'],
    });
    const firefox = renderManifest(template, 'firefox', values);
    expect(firefox.allowed_extensions).toEqual(['synapse@omnipilot.dev']);
    expect(firefox.allowed_origins).toBeUndefined();
  });

  it('rejects an unfilled placeholder instead of writing it literally', () => {
    expect(() => renderManifest(template, 'chrome', { COMPANION_PATH: '/opt/x.mjs' })).toThrow(
      /unfilled manifest placeholder/,
    );
  });

  it('rejects a target the template does not define', () => {
    expect(() => renderManifest(template, 'safari', values)).toThrow(/"safari" target/);
  });
});

describe('nativeMessagingDir', () => {
  it('resolves the browser-owned directory per platform', () => {
    expect(nativeMessagingDir('chrome', { platform: 'linux', home: '/home/u', env: {} })).toBe(
      '/home/u/.config/google-chrome/NativeMessagingHosts',
    );
    expect(nativeMessagingDir('edge', { platform: 'linux', home: '/home/u', env: {} })).toBe(
      '/home/u/.config/microsoft-edge/NativeMessagingHosts',
    );
    expect(nativeMessagingDir('firefox', { platform: 'linux', home: '/home/u', env: {} })).toBe(
      '/home/u/.mozilla/native-messaging-hosts',
    );
    expect(nativeMessagingDir('firefox', { platform: 'darwin', home: '/Users/u', env: {} })).toBe(
      '/Users/u/Library/Application Support/Mozilla/NativeMessagingHosts',
    );
    expect(
      nativeMessagingDir('chrome', {
        platform: 'win32',
        home: 'C:\\Users\\u',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\NativeMessagingHosts');
  });
});

describe('parseInstallArgs', () => {
  it('defaults to Chromium, a dry run of nothing, and no ids', () => {
    expect(parseInstallArgs([])).toEqual({
      browsers: ['chrome'],
      extensionId: null,
      firefoxId: null,
      companion: null,
      dryRun: false,
      help: false,
    });
  });

  it('expands --browser all and accepts explicit values', () => {
    const options = parseInstallArgs([
      '--dry-run',
      '--browser',
      'all',
      '--extension-id',
      'abc',
      '--firefox-id',
      'x@y',
      '--companion',
      '/opt/x.mjs',
    ]);
    expect(options.browsers).toEqual(ALL_BROWSERS);
    expect(options).toMatchObject({ dryRun: true, extensionId: 'abc', firefoxId: 'x@y', companion: '/opt/x.mjs' });
  });

  it('rejects unknown options and browsers', () => {
    expect(() => parseInstallArgs(['--nope'])).toThrow(/unknown option/);
    expect(() => parseInstallArgs(['--browser', 'safari'])).toThrow(/unknown browser/);
  });
});

describe('installPlan', () => {
  const platformContext = { platform: 'linux', home: '/home/u', env: {} };

  it('places one manifest per browser inside that browser directory', () => {
    const plan = installPlan(
      { browsers: ['chrome', 'firefox'], extensionId: 'abc', firefoxId: 'x@y', companion: '/opt/x.mjs', dryRun: true },
      template,
      platformContext,
    );
    expect(plan).toHaveLength(2);
    expect(plan[0].manifestPath).toBe(
      '/home/u/.config/google-chrome/NativeMessagingHosts/com.omnipilot.synapse.git_bridge.json',
    );
    expect(plan[0].manifest.path).toBe('/opt/x.mjs');
    expect(plan[1].manifestPath).toBe(
      '/home/u/.mozilla/native-messaging-hosts/com.omnipilot.synapse.git_bridge.json',
    );
    expect(plan[1].manifest.allowed_extensions).toEqual(['x@y']);
    expect(plan[0].registry).toBeNull();
  });

  it('reports the Windows registry command instead of writing one', () => {
    const plan = installPlan(
      { browsers: ['chrome'], extensionId: 'abc', companion: 'C:\\opt\\git-bridge.mjs', dryRun: true },
      template,
      {
        platform: 'win32',
        home: 'C:\\Users\\u',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      },
    );
    expect(plan[0].registry).toContain('reg add');
    expect(plan[0].registry).toContain('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts');
    expect(plan[0].manifestPath).toBe(
      'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\NativeMessagingHosts\\com.omnipilot.synapse.git_bridge.json',
    );
  });

  it('refuses a manifest path outside the browser directory', () => {
    const root = '/home/u/.config/google-chrome/NativeMessagingHosts';
    expect(() => assertInsideRoot(root, '/home/u/.ssh/evil.json', 'linux')).toThrow(/refusing to write/);
    expect(() => assertInsideRoot(root, `${root}/host.json`, 'linux')).not.toThrow();
  });
});

describe('companionPathCandidates', () => {
  it('prefers the packed bundle over the raw build output', () => {
    const [bundle, dist] = companionPathCandidates('/pkg', 'linux', 'x64');
    expect(bundle).toBe(join('/pkg', '.output', 'git-bridge-linux-x64.mjs'));
    expect(dist).toBe(join('/pkg', 'dist', 'main.js'));
  });
});

describe('install.mjs --dry-run', () => {
  it('runs with no arguments and writes nothing', () => {
    const result = spawnSync(process.execPath, [installScript, '--dry-run'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(HOST_NAME);
    expect(result.stdout).toContain('Dry run complete');
  });

  it('resolves a relative --companion to an absolute path in the manifest', () => {
    const result = spawnSync(
      process.execPath,
      [installScript, '--dry-run', '--companion', 'dist/main.js'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    // The JSON-escaped absolute path is what the manifest would carry.
    expect(result.stdout).toContain(JSON.stringify(resolve('dist', 'main.js')).slice(1, -1));
  });

  it('refuses a real install without an extension id', () => {
    const result = spawnSync(process.execPath, [installScript], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--extension-id is required');
  });
});
