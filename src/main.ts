import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache';
import { HttpClient } from '@actions/http-client';
import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

async function run(): Promise<void> {
  try {
    // Inputs
    const channelInput = core.getInput('channel') || '';
    let versionInput = core.getInput('version') || '';
    const authKey = core.getInput('authkey') || '';
    const oauthSecret = core.getInput('oauth-secret') || '';
    const tags = core.getInput('tags') || '';
    let sha256sum = core.getInput('sha256sum') || '';
    const additionalArgs = core.getInput('args') || '';
    const tailscaledArgs = core.getInput('tailscaled-args') || '';
    const hostnameInput = core.getInput('hostname') || '';
    const stateDir = core.getInput('statedir') || '';
    const timeoutStr = core.getInput('timeout') || '2m';

    // Channel & version are mutually exclusive
    if (channelInput && versionInput) {
      core.setFailed(
        `Inputs 'channel' and 'version' are mutually exclusive. Please specify only one.`
      );
      return;
    }

    // Validate auth info
    if (authKey === '' && (oauthSecret === '' || tags === '')) {
      core.setFailed(
        '⛔ OAuth identity empty. Provide either authkey OR (oauth-secret + tags).'
      );
      return;
    }

    // Detect OS and arch from environment
    const runnerOS = process.env['RUNNER_OS'] || '';
    let runnerArch = (process.env['RUNNER_ARCH'] || 'X64').toUpperCase();

    core.info(`Runner OS: ${runnerOS}, Arch: ${runnerArch}`);

    // Resolve final "channel" and "version" based on user input
    let finalChannel: 'stable'|'unstable' = 'stable'; // default
    let finalVersion = '';

    if (channelInput) {
      // User explicitly chose stable or unstable channel => fetch *latest* from that
      if (channelInput !== 'stable' && channelInput !== 'unstable') {
        core.setFailed(`Invalid channel: ${channelInput}. Must be 'stable' or 'unstable'.`);
        return;
      }
      finalChannel = channelInput as 'stable'|'unstable';
      finalVersion = await fetchLatestFromChannel(finalChannel);
      core.info(`Using channel='${finalChannel}' => latest version=${finalVersion}`);
    } else {
      // No channel => we rely on the 'version' input
      if (!versionInput) {
        // No channel and no version => default to stable-latest
        finalVersion = await fetchLatestFromChannel('stable');
        core.info(`No channel or version specified; defaulting to stable-latest => ${finalVersion}`);
      } else if (versionInput.toLowerCase() === 'latest') {
        // version=latest => treat as stable-latest
        finalVersion = await fetchLatestFromChannel('stable');
        core.info(`version=latest => stable-latest => ${finalVersion}`);
      } else {
        // A specific version (e.g. 1.40.0)
        finalVersion = versionInput;
        core.info(`Using specified version='${finalVersion}' from stable channel`);
      }
    }

    // We'll build a download URL from pkgs.tailscale.com/<finalChannel>
    // EXCEPT if user provided a specific version and no channel => we assume stable channel..
    let baseURL = `https://pkgs.tailscale.com/${finalChannel}`;
    // If the user didn't explicitly pick channel=unstable, we default to stable
    // (even for a specific version).

    const { platform, arch, archiveExt } = getPlatformInfo(runnerOS, runnerArch);
    if (!platform) {
      core.setFailed(`Unsupported runner OS/arch: OS=${runnerOS}, ARCH=${runnerArch}`);
      return;
    }

    // Example filenames:
    //   - Linux .tgz: tailscale_1.40.0_linux_amd64.tgz
    //   - macOS .tgz: tailscale_1.40.0_darwin_amd64.tgz
    //   - Windows .zip: tailscale_1.40.0_windows_amd64.zip
    const fileName = `tailscale_${finalVersion}_${platform}_${arch}.${archiveExt}`;
    const downloadURL = `${baseURL}/${fileName}`;

    core.info(`Downloading Tailscale from: ${downloadURL}`);
    const downloadPath = await tc.downloadTool(downloadURL);

    // If no sha256, try to fetch from .sha256
    if (!sha256sum) {
      const shaURL = `${downloadURL}.sha256`;
      core.info(`No sha256 input; attempting to fetch from ${shaURL} ...`);
      try {
        sha256sum = await fetchRemoteSha256(shaURL);
      } catch (e: any) {
        core.warning(`Failed to fetch remote SHA256: ${e.message}`);
      }
    }

    // If we have a sha256, compare
    if (sha256sum) {
      const actualSha256 = await computeFileSha256(downloadPath);
      core.info(`Expected SHA256: ${sha256sum}`);
      core.info(`Actual   SHA256: ${actualSha256}`);
      if (actualSha256 !== sha256sum.replace(/\s+/g, '')) {
        throw new Error(
          `SHA256 mismatch! Expected=${sha256sum}, got=${actualSha256}`
        );
      }
    } else {
      core.warning('No SHA256 provided or fetched; skipping checksum validation.');
    }

    // Extract the archive
    let extractDir = '';
    if (archiveExt === 'tgz') {
      extractDir = await tc.extractTar(downloadPath);
    } else if (archiveExt === 'zip') {
      extractDir = await tc.extractZip(downloadPath);
    } else {
      throw new Error(`Unsupported archive format: ${archiveExt}`);
    }
    // Remove the original .tgz/.zip
    fs.unlinkSync(downloadPath);

    // Add the extracted folder to PATH so `tailscale` is accessible
    core.addPath(extractDir);

    // Start tailscaled in background (if present
    const tailscaledPath = path.join(extractDir, getTailscaledBinaryName(runnerOS));
    if (fs.existsSync(tailscaledPath)) {
      await startEphemeralTailscaled(tailscaledPath, stateDir, tailscaledArgs);
    } else {
      core.warning(`tailscaled not found at: ${tailscaledPath}. Skipping daemon startup.`);
    }

    // tailscale up
    let finalAuthKey = authKey;
    let tagsArg = '';
    if (oauthSecret) {
      finalAuthKey = `${oauthSecret}?preauthorized=true&ephemeral=true`;
      tagsArg = `--advertise-tags=${tags}`;
    }

    const finalHostname = hostnameInput || `github-${await readSystemHostname()}`;
    const timeoutMs = parseDurationToMs(timeoutStr);

    const upArgs = [
      'up',
      tagsArg,
      `--authkey=${finalAuthKey}`,
      `--hostname=${finalHostname}`,
      '--accept-routes',
      ...splitArgs(additionalArgs)
    ].filter(Boolean);

    core.info(`Running 'tailscale up' with timeout=${timeoutMs}ms ...`);
    await runWithTimeout('tailscale', upArgs, timeoutMs);

    core.info('Tailscale connected successfully!');
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

/**
 * Fetch the latest version from either stable or unstable using @actions/http-client.
 */
async function fetchLatestFromChannel(channel: 'stable' | 'unstable'): Promise<string> {
  const http = new HttpClient('action-tailscale');
  const url = `https://pkgs.tailscale.com/${channel}/?mode=json`;
  const res = await http.get(url);
  if (res.message.statusCode !== 200) {
    throw new Error(`Failed to fetch latest from channel '${channel}'. HTTP ${res.message.statusCode}`);
  }
  const body = await res.readBody();
  const data = JSON.parse(body);
  if (!data.Version) {
    throw new Error(`No "Version" field found in ${channel} channel JSON.`);
  }
  return data.Version;
}

/**
 * Fetch a remote .sha256 file from the given URL.
 */
async function fetchRemoteSha256(url: string): Promise<string> {
  const http = new HttpClient('action-tailscale');
  const res = await http.get(url);
  if (res.message.statusCode !== 200) {
    throw new Error(`HTTP ${res.message.statusCode} fetching SHA256 from ${url}`);
  }
  return (await res.readBody()).trim();
}

/**
 * Compute SHA256 of a file on disk.
 */
async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Return platform/arch + archive extension for the Tailscale file name.
 * e.g. macOS => "darwin", Linux => "linux", Windows => "windows".
 * e.g. X64 => "amd64", ARM64 => "arm64", etc.
 */
function getPlatformInfo(os: string, arch: string) {
  let platform = '';
  let tsArch = '';
  let archiveExt = 'tgz';

  // OS => platform
  if (os === 'Linux') platform = 'linux';
  else if (os === 'macOS') platform = 'darwin';
  else if (os === 'Windows') {
    platform = 'windows';
    archiveExt = 'zip'; // Tailscale provides .zip for Windows
  }

  // ARCH => tailscale arch
  switch (arch) {
    case 'ARM64': tsArch = 'arm64'; break;
    case 'ARM':   tsArch = 'arm';   break;
    case 'X86':   tsArch = '386';   break;
    default:      tsArch = 'amd64'; break;
  }

  return { platform, arch: tsArch, archiveExt };
}

/**
 * Start tailscaled in the background if we have a separate daemon binary.
 */
async function startEphemeralTailscaled(
  daemonPath: string,
  stateDir: string,
  extraArgs: string
) {
  let stateArg = '--state=mem:';
  if (stateDir) {
    stateArg = `--statedir=${stateDir}`;
    await fs.promises.mkdir(stateDir, { recursive: true });
  }

  const daemonArgs = [
    daemonPath,
    stateArg,
    ...splitArgs(extraArgs)
  ];
  core.info(`Starting tailscaled in background: ${daemonArgs.join(' ')}`);

  const proc = spawn(daemonArgs[0], daemonArgs.slice(1), {
    detached: true,
    stdio: 'ignore'
  } as SpawnOptions);
  proc.unref();

  // Give the daemon a second to start, then we'll do a best-effort "tailscale status"
  await new Promise(r => setTimeout(r, 2000));
  try {
    await exec.exec('tailscale', ['status', '--json']);
  } catch (err) {
    core.warning(`tailscaled may not be fully started yet: ${(err as Error).message}`);
  }
}

/**
 * On success, resolve. On timeout, kill the process and reject.
 */
async function runWithTimeout(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let exited = false;

    core.info(`Executing: ${command} ${args.join(' ')} with timeout=${timeoutMs}ms`);
    const cp = spawn(command, args, { stdio: 'inherit' });

    cp.on('exit', (code) => {
      exited = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed with exit code ${code}`));
      }
    });

    cp.on('error', (err) => {
      if (!exited) {
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });

    timer = setTimeout(() => {
      if (!exited) {
        core.warning(`Killing ${command} due to timeout (${timeoutMs} ms)`);
        cp.kill('SIGTERM');
        reject(new Error(`${command} timed out after ${timeoutMs} ms`));
      }
    }, timeoutMs);
  });
}

/** Return "tailscaled" or "tailscaled.exe" depending on OS. */
function getTailscaledBinaryName(os: string): string {
  return os === 'Windows' ? 'tailscaled.exe' : 'tailscaled';
}

/** Use "hostname" command to read the system hostname, fallback if not found. */
async function readSystemHostname(): Promise<string> {
  try {
    const { stdout } = await exec.getExecOutput('hostname', [], { silent: true });
    return stdout.trim();
  } catch {
    return 'unknown-host';
  }
}

/** 
 * Convert a duration string like "2m", "10s", "250ms" to milliseconds. 
 * Default to 2min if invalid.
 */
function parseDurationToMs(d: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(d.trim().toLowerCase());
  if (!match) {
    return 2 * 60_000;
  }
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms': return val;
    case 's':  return val * 1000;
    case 'm':  return val * 60_000;
    case 'h':  return val * 3_600_000;
  }
  return 2 * 60_000;
}

/** 
 * A minimal argument splitter that respects quoted segments.
 */
function splitArgs(argString: string): string[] {
  if (!argString) return [];
  const regex = /[^\s"]+|"([^"]*)"/gi;
  const args: string[] = [];
  let match;
  while ((match = regex.exec(argString)) !== null) {
    args.push(match[1] ? match[1] : match[0]);
  }
  return args;
}

run();
