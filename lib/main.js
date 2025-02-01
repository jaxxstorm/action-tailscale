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
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
async function run() {
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
            (0, child_process_1.spawn)('sudo', [tailscaledBin], { detached: true, stdio: 'ignore' }).unref();
            await sleep(3000);
        }
        else if (runnerOS === 'macOS') {
            (0, child_process_1.spawn)('sudo', [tailscaledBin], { detached: true, stdio: 'ignore' }).unref();
            await sleep(3000);
        }
        else if (runnerOS === 'Windows') {
            (0, child_process_1.spawn)(tailscaledBin, [], { detached: true, stdio: 'ignore' }).unref();
            await sleep(3000);
        }
        else {
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
        }
        else {
            await exec.exec(tailscaleBin, upArgs);
        }
        core.info('Tailscale is up & running.');
    }
    catch (err) {
        core.setFailed(err.message);
    }
}
async function getGoPath() {
    if (process.env.GOPATH)
        return process.env.GOPATH;
    const { stdout } = await exec.getExecOutput('go', ['env', 'GOPATH'], { silent: true });
    return stdout.trim();
}
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
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
run();
//# sourceMappingURL=main.js.map