import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

function absoluteWindowsPath(value: string): boolean {
    // A leading slash without a drive is rooted on the current drive, not fully qualified.
    return path.win32.isAbsolute(value) && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value);
}

/** Resolve npm's Windows shim to its JS/native entry point without executing a shell. */
export function cliExecutable(command: string, platform = process.platform, env = process.env, cwd = process.cwd()): { command: string; prefix: string[] } {
    if (platform !== 'win32') { return { command, prefix: [] }; }
    if (/[\\/:]/.test(command) && !absoluteWindowsPath(command)) { throw new Error('CLI path must be absolute'); }
    const dirs = absoluteWindowsPath(command) ? [''] : (env.PATH || env.Path || '').split(';')
        .filter(dir => absoluteWindowsPath(dir) && path.resolve(dir).toLowerCase() !== path.resolve(cwd).toLowerCase()
            && path.resolve(dir).toLowerCase() !== path.resolve(process.cwd()).toLowerCase());
    for (const dir of dirs) {
        const base = path.resolve(dir, command);
        for (const suffix of path.extname(base) ? [''] : ['.exe', '.cmd', '']) {
            const file = base + suffix;
            if (!existsSync(file)) { continue; }
            if (/\.exe$/i.test(file)) { return { command: file, prefix: [] }; }
            if (!/\.cmd$/i.test(file)) { continue; }
            const shim = readFileSync(file, 'utf8');
            const entry = /"%dp0%[\\/]([^"\r\n]+\.(?:exe|[cm]?js))"\s+%\*/i.exec(shim)?.[1];
            if (!entry) { throw new Error('Unsupported CLI shim'); }
            const target = path.resolve(path.dirname(file), entry);
            if (!existsSync(target)) { throw new Error('CLI entry point missing'); }
            if (/\.exe$/i.test(target)) { return { command: target, prefix: [] }; }
            // The already-running Node/Electron runtime is trusted; never search cwd for node.exe.
            if (!path.isAbsolute(process.execPath)) { throw new Error('Node runtime path must be absolute'); }
            return { command: process.execPath, prefix: [target] };
        }
    }
    throw new Error('CLI executable missing');
}
export function spawnCli(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): ChildProcess {
    const executable = cliExecutable(command, process.platform, env, cwd);
    if (executable.prefix.length && process.versions.electron) { env = { ...env, ELECTRON_RUN_AS_NODE: '1' }; }
    return spawn(executable.command, [...executable.prefix, ...args], {
        env, cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe'
    });
}
export function killCliTree(child: ChildProcess, pid = child.pid): void {
    if (!pid) { return; }
    const fallback = (): void => { try { child.kill('SIGKILL'); } catch { /* Already gone. */ } };
    try {
        if (process.platform === 'win32') {
            const root = process.env.SystemRoot || process.env.SYSTEMROOT;
            if (!root || !absoluteWindowsPath(root)) { throw new Error('SystemRoot must be absolute'); }
            const killer = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)],
                { windowsHide: true, shell: false, stdio: 'ignore' });
            let failureHandled = false;
            const failed = (): void => {
                if (failureHandled) { return; }
                failureHandled = true;
                console.warn('[CLI-AGENTS] Process tree termination failed.');
                fallback();
            };
            killer.on('error', failed);
            killer.on('close', code => { if (code !== 0) { failed(); } });
        } else { process.kill(-pid, 'SIGKILL'); }
    } catch { console.warn('[CLI-AGENTS] Process tree termination failed.'); fallback(); }
}

export function destroyCliPipes(child: ChildProcess): void {
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
}
