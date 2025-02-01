"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const tc = __importStar(require("@actions/tool-cache"));
const http_client_1 = require("@actions/http-client");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
async function run() {
    try {
        // Inputs
        const channelInput = core.getInput('channel') || '';
        const versionInput = core.getInput('version') || '';
        const authKey = core.getInput('authkey') || '';
        const oauthSecret = core.getInput('oauth-client-secret') || '';
        const tags = core.getInput('tags') || '';
        let sha256sum = core.getInput('sha256sum') || '';
        const additionalArgs = core.getInput('args') || '';
        const tailscaledArgs = core.getInput('tailscaled-args') || '';
        const hostnameInput = core.getInput('hostname') || '';
        const stateDir = core.getInput('statedir') || '';
        const timeoutStr = core.getInput('timeout') || '2m';
        // channel & version are mutually exclusive
        if (channelInput && versionInput) {
            core.setFailed(`Inputs 'channel' and 'version' are mutually exclusive. Please specify only one.`);
            return;
        }
        // Validate auth info
        if (authKey === '' && (oauthSecret === '' || tags === '')) {
            core.setFailed('⛔ OAuth identity empty. Provide either authkey OR (oauth-secret + tags).');
            return;
        }
        // Detect OS/Arch
        const runnerOS = process.env['RUNNER_OS'] || '';
        const runnerArch = (process.env['RUNNER_ARCH'] || 'X64').toUpperCase();
        core.info(`Detected OS=${runnerOS} Arch=${runnerArch}`);
        // Resolve final version from channel or user input
        const finalChannel = channelInput === 'unstable' ? 'unstable' : 'stable';
        let finalVersion = '';
        if (channelInput) {
            // "stable" or "unstable" => fetch latest
            finalVersion = await fetchLatestFromChannel(finalChannel);
            core.info(`Using channel=${finalChannel} => latest version=${finalVersion}`);
        }
        else {
            if (!versionInput || versionInput.toLowerCase() === 'latest') {
                // no version => default stable-latest
                finalVersion = await fetchLatestFromChannel('stable');
                core.info(`No version => using stable-latest => ${finalVersion}`);
            }
            else {
                finalVersion = versionInput;
                core.info(`Using explicit version=${finalVersion} from stable channel`);
            }
        }
        // Build base URL
        const baseURL = `https://pkgs.tailscale.com/${finalChannel}`;
        // Decide which file to download
        const { fileName, isLinuxTgz, isMacPkg, isWinExe } = getTailscaleFilename(runnerOS, runnerArch, finalVersion);
        if (!fileName) {
            core.setFailed(`No recognized Tailscale artifact for OS=${runnerOS} Arch=${runnerArch}`);
            return;
        }
        const downloadURL = `${baseURL}/${fileName}`;
        core.info(`Downloading Tailscale from: ${downloadURL}`);
        const downloadPath = await tc.downloadTool(downloadURL);
        // If no sha256, attempt to fetch
        if (!sha256sum) {
            try {
                const shaURL = `${downloadURL}.sha256`;
                core.info(`Attempting to fetch sha256 from: ${shaURL}`);
                sha256sum = await fetchRemoteSha256(shaURL);
            }
            catch (e) {
                core.warning(`Failed to fetch remote SHA256: ${e.message}`);
            }
        }
        // If we have sha256, compare
        if (sha256sum) {
            const actualSha256 = await computeFileSha256(downloadPath);
            core.info(`Expected SHA256=${sha256sum}`);
            core.info(`Actual   SHA256=${actualSha256}`);
            if (sha256sum.replace(/\s+/g, '') !== actualSha256) {
                throw new Error(`SHA256 mismatch!`);
            }
        }
        else {
            core.warning(`No sha256 provided/fetched; skipping integrity check.`);
        }
        // 1) Windows => run the .exe installer
        if (isWinExe) {
            core.info('Installing Tailscale on Windows with silent .exe ...');
            await exec.exec(downloadPath, ['/quiet']);
            core.info('Windows Tailscale installed as a system service.');
            // Optionally remove the .exe
            // fs.unlinkSync(downloadPath);
        }
        // 2) macOS => run the .pkg installer
        else if (isMacPkg) {
            core.info('Installing Tailscale on macOS with .pkg ...');
            // Rename so it ends with .pkg (macOS installer often needs correct extension)
            const pkgPath = `${downloadPath}.pkg`;
            fs.renameSync(downloadPath, pkgPath);
            await exec.exec('sudo', ['installer', '-pkg', pkgPath, '-target', '/']);
            core.info('macOS Tailscale installed as a system service.');
            // Load the Tailscale daemon
            //
            const tailscalePlist = '/Library/LaunchDaemons/com.tailscale.tailscaled.plist';
            core.info(`Loading Tailscale daemon via launchctl: ${tailscalePlist} ...`);
            await exec.exec('sudo', ['launchctl', 'load', '-w', tailscalePlist]);
            await exec.exec('sudo', ['launchctl', 'start', 'com.tailscale.tailscaled']);
            core.info('macOS Tailscale daemon started.');
            // fs.unlinkSync(pkgPath);
        }
        // Linux => ephemeral .tgz
        else if (isLinuxTgz) {
            core.info('Using ephemeral .tgz approach on Linux...');
            const extractDir = await tc.extractTar(downloadPath);
            fs.unlinkSync(downloadPath);
            // The tar typically has a subdir named tailscale_VERSION_ARCH/
            const subDirName = `tailscale_${finalVersion}_${mapArch(runnerArch)}`;
            const subDirPath = path.join(extractDir, subDirName);
            if (fs.existsSync(subDirPath)) {
                core.info(`Found subdir: ${subDirPath}`);
                core.addPath(subDirPath);
            }
            else {
                core.info(`No subdir found named ${subDirName}. Adding root extractDir to PATH: ${extractDir}`);
                core.addPath(extractDir);
            }
            // Start ephemeral tailscaled if present
            const daemonPath = path.join(subDirPath, 'tailscaled');
            if (fs.existsSync(daemonPath)) {
                core.info(`Starting ephemeral tailscaled at ${daemonPath} ...`);
                await startEphemeralTailscaled(daemonPath, stateDir, tailscaledArgs);
            }
            else {
                core.warning(`No tailscaled binary found at ${daemonPath}; skipping daemon startup.`);
            }
        }
        else {
            // Not Windows, mac, or recognized Linux => skip?
            core.warning(`Unsupported OS or approach. No install or ephemeral extraction performed.`);
            return;
        }
        // Now run "tailscale up"
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
        core.info(`Running 'tailscale up' with timeout=${timeoutMs} ms...`);
        if (runnerOS === 'Linux') {
            // On Linux ephemeral, we likely need sudo for networking
            await runWithTimeout('sudo', ['tailscale', ...upArgs], timeoutMs);
        }
        else if (runnerOS === 'macOS') {
            // If your .pkg installs an actual 'tailscale' CLI in /usr/local/bin,
            // you can do:
            //
            //   await runWithTimeout('tailscale', upArgs, timeoutMs);
            //
            // or if you want to invoke the .app binary directly:
            const tailscaleAppBin = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
            await runWithTimeout(tailscaleAppBin, upArgs, timeoutMs);
        }
        else {
            // Windows
            await runWithTimeout('tailscale', upArgs, timeoutMs);
        }
        core.info('Tailscale connected successfully!');
    }
    catch (err) {
        core.setFailed(err.message);
    }
}
function getTailscaleFilename(os, arch, version) {
    if (os === 'Windows') {
        return {
            fileName: `tailscale-setup-${version}.exe`,
            isWinExe: true,
            isMacPkg: false,
            isLinuxTgz: false
        };
    }
    else if (os === 'macOS') {
        return {
            fileName: `Tailscale-${version}-macos.pkg`,
            isWinExe: false,
            isMacPkg: true,
            isLinuxTgz: false
        };
    }
    else if (os === 'Linux') {
        const mapped = mapArch(arch);
        return {
            fileName: `tailscale_${version}_${mapped}.tgz`,
            isWinExe: false,
            isMacPkg: false,
            isLinuxTgz: true
        };
    }
    return { fileName: '', isWinExe: false, isMacPkg: false, isLinuxTgz: false };
}
function mapArch(runnerArch) {
    switch (runnerArch) {
        case 'ARM64': return 'arm64';
        case 'ARM': return 'arm';
        case 'X86': return '386';
        default: return 'amd64'; // includes X64
    }
}
/** Download .sha256 from pkgs.tailscale.com */
async function fetchRemoteSha256(url) {
    const http = new http_client_1.HttpClient('ts-action');
    const res = await http.get(url);
    if (res.message.statusCode !== 200) {
        throw new Error(`Failed to fetch SHA256: HTTP ${res.message.statusCode}`);
    }
    return (await res.readBody()).trim();
}
/** Compute SHA256 of a file on disk */
async function computeFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}
/** Fetch the latest from stable or unstable channel */
async function fetchLatestFromChannel(channel) {
    const http = new http_client_1.HttpClient('ts-action');
    const url = `https://pkgs.tailscale.com/${channel}/?mode=json`;
    const res = await http.get(url);
    if (res.message.statusCode !== 200) {
        throw new Error(`HTTP ${res.message.statusCode} fetching latest from ${channel}`);
    }
    const body = await res.readBody();
    const data = JSON.parse(body);
    if (!data.Version) {
        throw new Error(`No "Version" in JSON for channel ${channel}`);
    }
    return data.Version;
}
/** Start ephemeral tailscaled on Linux after extracting. */
async function startEphemeralTailscaled(daemonPath, stateDir, extraArgs) {
    let stateArg = '--state=mem:';
    if (stateDir) {
        stateArg = `--statedir=${stateDir}`;
        await fs.promises.mkdir(stateDir, { recursive: true });
    }
    const daemonArgs = [
        'sudo',
        daemonPath,
        stateArg,
        ...splitArgs(extraArgs)
    ];
    core.info(`Spawning tailscaled: ${daemonArgs.join(' ')}`);
    const proc = (0, child_process_1.spawn)(daemonArgs[0], daemonArgs.slice(1), {
        detached: true,
        stdio: 'ignore'
    });
    proc.unref();
    // Quick wait, then 'sudo tailscale status'
    await new Promise(r => setTimeout(r, 4000));
    try {
        await exec.exec('sudo', ['tailscale', 'status', '--json']);
    }
    catch (err) {
        core.warning(`tailscaled may not be ready yet: ${err.message}`);
    }
}
/** Run a command with a millisecond timeout */
async function runWithTimeout(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let timer = null;
        let exited = false;
        core.info(`Running: ${cmd} ${args.join(' ')} (timeout=${timeoutMs}ms)`);
        const cp = (0, child_process_1.spawn)(cmd, args, { stdio: 'inherit' });
        cp.on('exit', code => {
            exited = true;
            if (timer)
                clearTimeout(timer);
            if (code === 0)
                resolve();
            else
                reject(new Error(`${cmd} exited with code ${code}`));
        });
        cp.on('error', err => {
            if (!exited) {
                if (timer)
                    clearTimeout(timer);
                reject(err);
            }
        });
        timer = setTimeout(() => {
            if (!exited) {
                core.warning(`Killing ${cmd} due to timeout (${timeoutMs}ms)`);
                cp.kill('SIGTERM');
                reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);
    });
}
/** Use 'hostname' or fallback */
async function readSystemHostname() {
    try {
        const { stdout } = await exec.getExecOutput('hostname', [], { silent: true });
        return stdout.trim();
    }
    catch {
        return 'unknown-host';
    }
}
/** Convert "2m", "30s", "250ms" => milliseconds, default 2m if invalid */
function parseDurationToMs(d) {
    const match = /^(\d+)(ms|s|m|h)$/.exec(d.trim().toLowerCase());
    if (!match) {
        return 120000; // default 2min
    }
    const val = parseInt(match[1], 10);
    switch (match[2]) {
        case 'ms': return val;
        case 's': return val * 1000;
        case 'm': return val * 60000;
        case 'h': return val * 3600000;
    }
    return 120000;
}
/** Minimal argument splitter that respects quoted segments, e.g. --foo "val" */
function splitArgs(argString) {
    if (!argString)
        return [];
    const regex = /[^\s"]+|"([^"]*)"/gi;
    const args = [];
    let match;
    while ((match = regex.exec(argString)) !== null) {
        args.push(match[1] ? match[1] : match[0]);
    }
    return args;
}
run();
//# sourceMappingURL=main.js.map