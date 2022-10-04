import { execSync } from 'child_process';
import {
  CompletionItem,
  CompletionList,
  ExtensionContext,
  LanguageClient,
  LanguageClientOptions,
  Position,
  Range,
  ServerOptions,
  services,
  TextEdit,
  window,
  workspace,
  WorkspaceConfiguration,
} from 'coc.nvim';
import fs from 'fs';
import os from 'os';
import path from 'path';
import which from 'which';

class Config {
  private cfg: WorkspaceConfiguration;

  constructor() {
    this.cfg = workspace.getConfiguration('julia');
  }

  get enabled() {
    return this.cfg.get('enabled') as boolean;
  }

  get executablePath() {
    return this.cfg.get('executablePath') as string;
  }

  get environmentPath() {
    return this.cfg.get('environmentPath') as string;
  }
}

interface Pkg {
  state: string;
  hash: string;
  name: string;
  version: string;
  repo: string;
}

export class Ctx {
  public readonly config: Config;
  private pkging = false;
  private lsProj: string;
  private mainJulia: string;
  private compileEnv: string;
  private sysimgDir: string;
  constructor(private readonly context: ExtensionContext) {
    this.config = new Config();
    this.lsProj = path.join(context.extensionPath, 'server', 'JuliaLS'); // lgtm[js/shell-command-constructed-from-input]
    this.mainJulia = path.join(this.lsProj, 'src', 'main.jl'); // lgtm[js/shell-command-constructed-from-input]
    this.compileEnv = path.join(context.extensionPath, 'server', 'compile_env'); // lgtm[js/shell-command-constructed-from-input]
    if (!fs.existsSync(context.storagePath)) {
      fs.mkdirSync(context.storagePath);
    }
    const version = this.resolveJuliaVersion();
    this.sysimgDir = path.join(context.storagePath, `sysimg-${version}`);
    if (!fs.existsSync(this.sysimgDir)) {
      fs.mkdirSync(this.sysimgDir);
    }
  }

  resolveJuliaBin(): string | null {
    let bin = this.config.executablePath;
    if (bin.startsWith('~')) {
      bin = os.homedir() + bin.slice(1);
    }
    if (bin && fs.existsSync(bin)) {
      return bin;
    }

    const cmd = process.platform === 'win32' ? 'julia.exe' : 'julia';
    return which.sync(cmd, { nothrow: true });
  }

  private resolveJuliaVersion(): string {
    const bin = this.resolveJuliaBin()!;
    const cmd = `${bin} --startup-file=no --history-file=no -e "println(VERSION)"`;
    return execSync(cmd).toString().trim();
  }

  private formatPkg(vals: string[]): Pkg[] {
    const pkgs: Pkg[] = [];
    for (const val of vals) {
      const parts = val.split(' ');
      if (parts.length === 4 || parts.length === 5) {
        pkgs.push({
          state: parts[0],
          hash: parts[1],
          name: parts[2],
          version: parts[3],
          repo: parts[4] || '',
        });
      }
    }

    return pkgs;
  }

  private async resolveMissingPkgs(projPath: string): Promise<void> {
    const bin = this.resolveJuliaBin()!;
    let cmd = `${bin} --project="${projPath}" --startup-file=no --history-file=no -e "using Pkg; Pkg.status()"`;
    const pkgs = this.formatPkg(execSync(cmd).toString().split('\n'));
    if (pkgs.some((p) => p.state === '→')) {
      const projName = path.basename(projPath);
      const ok = await window.showPrompt(`Some ${projName} deps are missing, would you like to install now?`);
      if (ok) {
        this.pkging = true;
        cmd = `${bin} --project="${projPath}" --startup-file=no --history-file=no -e "using Pkg; Pkg.instantiate()"`;

        await window.createTerminal({ name: 'coc-julia-ls' }).then((t) => t.sendText(cmd));
      }
    }
  }

  private async resolveEnvPath() {
    if (this.config.environmentPath) {
      return this.config.environmentPath;
    }

    const bin = this.resolveJuliaBin()!;
    const cmd = `${bin} --project=@. --startup-file=no --history-file=no -e "using Pkg; println(dirname(Pkg.Types.Context().env.project_file))"`;
    return execSync(cmd).toString().trim();
  }

  private async resolveSysimgPath() {
    const sysimgs = {
      darwin: 'sys.dylib',
      linux: 'sys.so',
      win32: 'sys.dll',
    };
    const sysimg_name = sysimgs[process.platform];
    const sysimg = path.join(this.sysimgDir, sysimg_name);
    if (fs.existsSync(sysimg)) {
      return sysimg;
    }
    const bin = this.resolveJuliaBin()!;
    const cmd = `${bin} --project=${this.compileEnv} --startup-file=no --history-file=no -e "print(Base.Sys.BINDIR)"`;
    const bindir = execSync(cmd).toString().trim();
    return path.join(path.dirname(bindir), 'lib', 'julia', sysimg_name);
  }

  async compileServerSysimg(args: string[]) {
    await this.resolveMissingPkgs(this.compileEnv);
    if (this.pkging) return;

    window.showInformationMessage('PackageCompiler.jl will take about 20 mins to compile...');
    const bin = this.resolveJuliaBin()!;
    await window.createTerminal({ name: 'coc-julia-ls' }).then((t) => {
      args.unshift(path.join(this.lsProj, 'src', 'exec.jl'));
      const files = args.join(' ');
      const cmd = `${bin} --project=${this.compileEnv} ${path.join(this.compileEnv, 'compile.jl')} -s ${this.lsProj} ${this.sysimgDir} ${files}`;
      t.sendText(cmd);
    });
  }

  private async prepareJuliaArgs(): Promise<string[]> {
    const sysimg = await this.resolveSysimgPath();
    return ['--startup-file=no', '--history-file=no', `--sysimage=${sysimg}`, '--depwarn=no', `--project=${this.lsProj}`, this.mainJulia];
  }

  private async prepareLSArgs(): Promise<string[]> {
    const env = await this.resolveEnvPath();
    const depopPath = process.env.JULIA_DEPOT_PATH ? process.env.JULIA_DEPOT_PATH : '';
    return [env, '--debug=no', depopPath, this.context.storagePath];
  }

  async startServer() {
    await this.resolveMissingPkgs(this.lsProj);
    if (this.pkging) return;

    const bin = this.resolveJuliaBin()!;
    let args: string[] = await this.prepareLSArgs();
    const juliaArgs = await this.prepareJuliaArgs();
    args = juliaArgs.concat(args);

    const tmpdir = ((await workspace.nvim.eval('$TMPDIR')) as string) || process.env.TMPDIR || process.env.TMP;
    const serverOptions: ServerOptions = {
      command: bin,
      args,
      options: { env: { ...process.env, TMPDIR: tmpdir } },
    };
    const clientOptions: LanguageClientOptions = {
      documentSelector: ['julia', 'juliamarkdown'],
      initializationOptions: workspace.getConfiguration('julia'),
      synchronize: {
        configurationSection: ['julia.lint'],
        fileEvents: workspace.createFileSystemWatcher('**/*.{jl,jmd}'),
      },
      progressOnInitialization: true,
      middleware: {
        provideCompletionItem: async (document, position, context, token, next) => {
          // @ts-ignore
          const option = context.option!;
          const input = option.input.startsWith(option.word) ? option.input : option.word + option.input;
          const res = (await next(document, position, context, token)) as CompletionList;
          const items: CompletionItem[] = [];
          if (res && Array.isArray(res.items)) {
            for (const item of res.items) {
              if (item.textEdit && TextEdit.is(item.textEdit) && (item.kind === 14 || item.kind === 17)) {
                const newText = item.textEdit.newText;
                if (!newText.startsWith(input)) {
                  const range = Object.assign({}, item.textEdit.range);
                  const start = Position.create(range.start.line, range.start.character - input.length);
                  const end = Position.create(range.end.line, range.end.character);
                  item.textEdit.newText = `${input}${newText}`;
                  item.textEdit.range = Range.create(start, end);
                }
              }

              items.push(item);
            }
          }

          return { items, isIncomplete: res.isIncomplete };
        },
      },
    };

    const client = new LanguageClient('julia', 'Julia Language Server', serverOptions, clientOptions);
    this.context.subscriptions.push(services.registLanguageClient(client));
  }
}

/* vim: set ts=2 sw=2: */
