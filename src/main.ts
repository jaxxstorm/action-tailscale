import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { spawn } from 'child_process';
import * as path from 'path';

async function run(): Promise<void> {
  try {
    const versionInput = core.getInput('version') || 'latest';
    const authKey = core.getInput('authkey') || '';
    const oauthSecret = core.getInput('oauth-client-secret') || '';
    const tags = core.getInput('tags') || '';
    const hostname = core.getInput('hostname') || '';
    const extraUpArgs = core.getInput('args') || '';
    const runnerOS = process.env.RUNNER_OS || '';
    const tailscaleRef = versionInput.toLowerCase() === 'latest' ? 'main' : `v${versionInput.replace(/^v/, '')}`;
    await exec.exec('go', ['install', `tailscale.com/cmd/tailscale${','}tailscaled@${tailscaleRef}`]);
    const gopath = await getGoPath();
    const binDir = path.join(gopath, 'bin');
    const tailscaleBin = path.join(binDir, 'tailscale');
    const tailscaledBin = path.join(binDir, 'tailscaled');
    if (runnerOS === 'Linux') {
      spawn('sudo', [tailscaledBin], { detached: true, stdio: 'ignore' }).unref();
      await sleep(3000);
    } else if (runnerOS === 'macOS') {
      spawn('sudo', [tailscaledBin], { detached: true, stdio: 'ignore' }).unref();
      await sleep(3000);
    } else if (runnerOS === 'Windows') {
      spawn(tailscaledBin, [], { detached: true, stdio: 'ignore' }).unref();
      await sleep(3000);
    } else {
      core.setFailed(`Unsupported runner OS: ${runnerOS}`);
      return;
    }
    let finalAuthKey = authKey;
    let tagsArg = '';
    if (oauthSecret) {
      finalAuthKey = `${oauthSecret}?preauthorized=true&ephemeral=true`;
      tagsArg = `--advertise-tags=${tags}`;
    }
    const upArgs = [
      'up',
      tagsArg,
      `--authkey=${finalAuthKey}`,
      hostname ? `--hostname=${hostname}` : '',
      '--accept-routes',
      ...splitArgs(extraUpArgs)
    ].filter(Boolean);
    if (runnerOS === 'Linux' || runnerOS === 'macOS') {
      await exec.exec('sudo', [tailscaleBin, ...upArgs]);
    } else {
      await exec.exec(tailscaleBin, upArgs);
    }
    core.info('Tailscale is up & running.');
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

async function getGoPath(): Promise<string> {
  if (process.env.GOPATH) return process.env.GOPATH;
  const { stdout } = await exec.getExecOutput('go', ['env', 'GOPATH'], { silent: true });
  return stdout.trim();
}

function splitArgs(argString: string): string[] {
  if (!argString) return [];
  const regex = /[^\s"]+|"([^"]*)"/gi;
  const args: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(argString)) !== null) {
    args.push(match[1] ? match[1] : match[0]);
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

run();
