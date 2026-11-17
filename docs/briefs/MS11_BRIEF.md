# MS11 実装ブリーフ: チャットの隣で組み込みターミナルが使える

> 調査担当 (Sonnet) 作成。コード変更・コミットは行っていない。実装は Codex CLI (別セッション) に引き継ぐ想定。
> 参照 SPEC: `docs/specs/ms-11-spec-チャットの隣で組み込みターミナルが使える.md`
> 確定済みの設計判断 (下パネル配置・専用トグルボタン・希釈フィルタ不変更・node_modules 無改変・AI連携等はスコープ外) は変更不可の前提として扱った。

## 0. 最重要の発見 (SPEC / 既知調査結果を裏付け・補強する事実)

SPEC は「ターミナル機能は依存として眠っており、コマンドやショートカットは生きている」と述べているが、**実際にはそれ以上に "眠っていない"**。node_modules を実測した結果、以下が新たに判明した。

1. **`Ctrl+`` (バッククォート) で今すぐターミナルが開く。** `TerminalFrontendContribution` の `KeybindingContribution` はフィルタされておらず (`arschat-ide-dilution.ts` の `MENU_FILTERED`/`ACTIVITY_BAR_FILTERED` のどちらにも入っていない)、`terminal-frontend-contribution.js:804-807` で `workbench.action.terminal.toggleTerminal` に `ctrl+\`` が素で登録されている。ArsChat 側で何も実装しなくても、このキーバインドは今の time point で機能する (要実機確認だが、コード上は確実)。
2. **`toggleTerminal()` という「開閉トグル」の完成品ロジックが Theia 本体に既に存在する** (`terminal-frontend-contribution.js:578-600`)。下パネルにターミナルが無ければ新規作成、あれば expand/collapse・アクティブ化を面倒みる。**ArsChat 側でトグル判定ロジックを自前実装する必要は無く、この既存コマンドをボタンの `onClick` から呼ぶだけで SPEC 受入条件 1・2・4 が満たせる。**
3. **`TerminalFrontendContribution` は `FrontendApplicationContribution` としてもフィルタされていない** (`arschat-ide-dilution.ts` の `ACTIVITY_BAR_FILTERED` に `TerminalFrontendContribution` は含まれない。`MENU_FILTERED` にのみ含まれ、これはトップメニューの "Terminal" 項目を消すためのフィルタ)。そのため `TerminalFrontendContribution.initializeLayout()` (`terminal-frontend-contribution.js:226-245`) が **フレッシュな (永続レイアウト未生成の) プロファイルで既に実行され、下パネルに未展開のターミナルウィジェットを 1 つ自動生成し、実際にシェルプロセスを起動している** (`termWidget.start()` を呼ぶ。`preferenceService.get('terminal.grouping.mode')` は `@theia/terminal-manager` 依存なしの本プロジェクトでは常に `undefined` なので早期returnしない)。つまり **「下パネルは現在未使用」は ArsChat 自前コードの話であり、Theia 本体は既に下パネルにターミナルの種を仕込んでいる**。ms-11 が何もしなくても、初回起動時に裏で1つ shell プロセスが立っている可能性が高い (下パネルが閉じているので画面には見えない)。この開発環境は PoC 初期から `@theia/terminal` を依存に持つため、**既存の永続レイアウト (electron のユーザーデータ) に、この「種」ターミナルが既に保存されている可能性がある** — 実機確認時に下パネルを一度開いて中身を確認すること。

これらは SPEC の「既に生きている」という記述を裏切るものではなく、むしろ **ms-11 の実装コストが SPEC の想定よりさらに小さい** ことを意味する。ArsChat が新規に書くコードは実質「ヘッダーにボタンを1つ足し、既存コマンド `workbench.action.terminal.toggleTerminal` を呼ぶ」だけで良い。

## 1. 現状分析

### 1.1 コマンド・キーバインドの生存確認 (node_modules 実測)

`node_modules/@theia/terminal/lib/browser/terminal-frontend-module.js:73-117`:
```js
bind(terminal_frontend_contribution_1.TerminalFrontendContribution).toSelf().inSingletonScope();
for (const identifier of [CommandContribution, MenuContribution, KeybindingContribution, TabBarToolbarContribution, ColorContribution]) {
    bind(identifier).toService(TerminalFrontendContribution);
}
...
bind(FrontendApplicationContribution).toService(TerminalFrontendContribution);
```
`arschat-ide-dilution.ts:89-106` の `MENU_FILTERED` は `TerminalFrontendContribution` を含む (`// "Terminal"` コメントあり) → **`MenuContribution` のみフィルタ**。`ACTIVITY_BAR_FILTERED` (L117-126) には含まれない → **`CommandContribution`/`KeybindingContribution`/`FrontendApplicationContribution`/`TabBarToolbarContribution`/`ColorContribution` は無傷**。これは既知の調査結果どおりで、今回 node_modules 実測で裏取りできた。

### 1.2 関連コマンド ID (`terminal-frontend-contribution.js:52-131`)

| 定数 | id | 用途 |
|---|---|---|
| `TerminalCommands.NEW` | `terminal:new` | 新規ターミナルを常に1個追加 (トグルではない) |
| `TerminalCommands.TOGGLE_TERMINAL` | `workbench.action.terminal.toggleTerminal` | **開閉トグル (ms-11 で使うのはこれ)** |
| `TerminalCommands.KILL_TERMINAL` | `terminal:kill` (実際は `KILL_TERMINAL` 定数、grep未確認のためid文字列は実装時に再確認) | アクティブターミナルを閉じる |

`toggleTerminal()` の実装 (`terminal-frontend-contribution.js:578-600`, 逐語):
```js
toggleTerminal() {
    const terminals = this.shell.getWidgets('bottom').filter(w => w instanceof TerminalWidget);
    if (terminals.length === 0) {
        this.openTerminal();
        return;
    }
    if (!this.shell.isExpanded('bottom')) {
        this.shell.expandPanel('bottom');
        terminals[0].activate();
    } else {
        const visibleTerminal = terminals.find(t => t.isVisible);
        if (!visibleTerminal) {
            this.shell.bottomPanel.activateWidget(terminals[0]);
        } else if (this.shell.activeWidget !== visibleTerminal) {
            this.shell.bottomPanel.activateWidget(visibleTerminal);
        } else {
            this.shell.collapsePanel('bottom');
        }
    }
}
```
「無ければ作る→展開してれば閉じる→畳んでれば展開する→他のタブがアクティブならターミナルタブへ切替える」という UX 的にこなれたトグルが既製品として存在する。ArsChat の受入条件 1・2・4 (1クリックで開く/下パネルに開く/閉じて開き直せる) はこの1コマンドの呼び出しだけで満たせる。

`TerminalCommands.TOGGLE_TERMINAL` には `ctrl+\`` のキーバインドも既に登録済み (`terminal-frontend-contribution.js:804-807`)。ArsChat 専用ボタンはこの既存コマンドの「見た目の入口」を追加するだけ、という位置づけになる。

### 1.3 `openTerminal()` (トグルが「無ければ作る」経路で呼ぶ関数) の注意点

`terminal-frontend-contribution.js:912-933`。デフォルトプロファイルで `profile.start()` → `this.open(termWidget, {...})`。**`this.workspaceService.workspace` が真 (= ワークスペース/フォルダが開かれている) の場合のみ** `selectTerminalCwd()` (`terminal-frontend-contribution.js:866-887`) を呼び、複数ルートワークスペースなら QuickPick ダイアログで cwd を聞く。ArsChat は File Navigator を希釈済みでワークスペースを開くUIを主要導線として持たないため、通常は `workspaceService.workspace` が unset で **QuickPick は出ない想定**。ただし「File」メニューは希釈されておらず (`arschat-ide-dilution.ts` に File は含まれない)、理論上ユーザーが File 経由でフォルダを開けばこの分岐に入りうる。ms-11 のスコープでは深追い不要だが、実機確認時に「ワークスペース未オープン状態でボタンを押す」ことを確認すれば十分。

## 2. ボタンの置き場所の提案

### 2.1 現状の UI 構造 (`arschat-chat-widget.tsx:1588-1641`)

```tsx
<div id='arschat-chat-root' ...>
    <div className='arschat-chat-header'>
        <span className='arschat-chat-header-title'>ArsChat</span>
        <div className='arschat-chat-header-controls'>
            <button id='arschat-new-chat-button' className='theia-button secondary arschat-new-chat-button' ...>+ 新規</button>
            <select id='arschat-persona-select' .../>
            <select id='arschat-provider-select' .../>
            <select id='arschat-model-select' .../>
        </div>
    </div>
    ...
```
`.arschat-chat-header-controls` (`style/index.css:30-35`, `margin-left: auto; display: flex; gap: 8px`) がヘッダー右側のボタン/セレクト群の入れ物。既存ボタンは `theia-button secondary` (Theia標準クラス) + `arschat-new-chat-button` (専用クラス、`style/index.css:243-246` でフォントサイズのみ上書き) という組み合わせ。

### 2.2 推奨: `.arschat-chat-header-controls` の末尾に新規ボタンを追加

```tsx
<button
    id='arschat-terminal-toggle-button'
    className='theia-button secondary arschat-terminal-toggle-button'
    title='ターミナルの表示/非表示'
    onClick={() => this.toggleTerminal()}
>ターミナル</button>
```
- 配置は `model-select` の後ろ (`arschat-chat-widget.tsx:1639` の `</select>` の直後、`</div>` (controls終了) の直前)。プロバイダ/モデル選択とは独立した機能なので視覚的に区切りたければ CSS で `margin-left: 8px` 程度の余白を足すか、`| ` セパレータを挟む微調整は実装者判断で良い (SPEC は文言・見た目を厳密指定していない)。
- CSS 新規クラス `arschat-terminal-toggle-button` を `style/index.css` の `.arschat-new-chat-button` (L243-246) の近くに追加 (命名規約 `arschat-<component>-<part>` 準拠)。基本は `theia-button secondary` の見た目を継承するだけで良く、専用スタイルはほぼ不要 (MS10 の「新規CSS基本不要」と同じ判断)。
- アイコンのみのミニマルなボタンにしたい場合は `codicon codicon-terminal` (Theia の codicon フォント、`terminal-frontend-contribution.js` の他の toolbar item でも `codicon('add')` 等が使われている実績あり) を子要素に使う案もあるが、既存の「+ 新規」がテキストラベル方式なので **一貫性重視でテキストラベル (`ターミナル`) を第一候補として推奨**。

### 2.3 代替案の比較: Theia `TabBarToolbarContribution`

Theia 標準の「ウィジェットタイトルバー右上のツールバーアイコン」(`TabBarToolbarContribution.registerToolbarItems`) に登録する方式も技術的には可能 (`terminal-frontend-contribution.js:671-679` に実例あり)。

| 観点 | ヘッダー内ボタン (推奨) | TabBarToolbarContribution |
|---|---|---|
| 実装量 | `arschat-chat-widget.tsx` に button 1つ追加のみ | 新規 `@injectable` クラス + DI 登録 (`bind(TabBarToolbarContribution).toService(...)`) が別途必要 |
| 既存パターンとの一貫性 | ◎ (+新規ボタンと同じ書き方) | △ (ArsChat には前例なし、`ArschatChatWidget` はタイトルバーの標準タブUIを使っていない main エリアの単一ウィジェットなので、そもそもタブバーが常時見えるとは限らない) |
| チャット強制 activate との相性 | ◎ (ヘッダーはウィジェット内なので常に見える) | △ (タブバーツールバーは対象ウィジェットがアクティブな時のみ出る実装が一般的) |

**結論: ヘッダー内ボタンを推奨。** TabBarToolbarContribution は「ArsChat の他のビュー (履歴パネル等) にも同種の操作ボタンを横展開したくなったとき」の将来選択肢として記録に留める。

## 3. ターミナル開閉の実装方式

### 3.1 コマンド呼び出し方式 (推奨: 既存コマンドに委譲)

`ArschatChatWidget` に `CommandRegistry` を新規注入する:
```ts
import { CommandRegistry } from '@theia/core/lib/common/command';
...
@inject(CommandRegistry)
protected readonly commandRegistry!: CommandRegistry;
```
(`arschat-chat-contribution.ts:29` で同じ import パスが既に使われている実績あり)

ボタンハンドラ:
```ts
toggleTerminal(): void {
    this.commandRegistry.executeCommand('workbench.action.terminal.toggleTerminal');
}
```
コマンド id は `TerminalCommands.TOGGLE_TERMINAL.id` として `@theia/terminal` から型付きで import することもできるが、**`arschat-chat` は現時点で `@theia/terminal` に依存していない** (`arschat-chat/package.json:14-27` に記載なし。一方 `arschat-branding/package.json:29` と `electron-app`/`browser-app` の `package.json` には `"@theia/terminal": "1.71.2"` が既にある)。文字列直書きでも動くが、他の MS 全体の作法 (型を通す・生文字列を避ける) に合わせるなら `arschat-chat/package.json` の `dependencies` に `"@theia/terminal": "1.71.2"` を追加し、`import { TerminalCommands } from '@theia/terminal/lib/browser/terminal-frontend-contribution';` として `TerminalCommands.TOGGLE_TERMINAL.id` を使うほうが安全 (将来 Theia バージョンアップで id 文字列が変わってもコンパイルエラーで検知できる)。**推奨は後者 (型付き import + package.json 追加)**。

自前でトグル判定 (`shell.getWidgets('bottom')` を見て開閉状態を判断し `expandPanel`/`collapsePanel` を呼び分ける) を書くことも可能だが、§1.2 の通り Theia 本体に完成品があるため **再実装は非推奨**。バグの二重管理・Theia側の将来の挙動変更 (例: マルチターミナルのタブ切替ロジック改善) に追従できなくなる。

### 3.2 ApplicationShell の関連 API (`node_modules/@theia/core/lib/browser/shell/application-shell.js`)

参考として (自前実装しない場合でも、ボタンの見た目状態を判断したくなったときのため):

| API | 行 | 用途 |
|---|---|---|
| `shell.getWidgets('bottom')` | L894-901 | 下パネルの現在のウィジェット一覧 |
| `shell.isExpanded('bottom')` | L1462-1466 | 下パネルが展開中か |
| `shell.expandPanel('bottom')` | L1318-1332 (実体は `expandBottomPanel()` L1362-1398) | 下パネルを展開 |
| `shell.collapsePanel('bottom')` | L1403- (実体は `collapseBottomPanel()`) | 下パネルを畳む |
| `shell.revealWidget(id)` | L1257- | 特定ウィジェットをどのエリアにあってもアクティブ化して見せる (トグルの代わりに「常に開く」だけしたい場合の代替) |

### 3.3 DI 登録先

新規注入は `arschat-chat-widget.tsx` の `ArschatChatWidget` クラスに `@inject(CommandRegistry)` を1行足すだけで、`arschat-chat-frontend-module.ts` 側の変更は不要 (`CommandRegistry` は `@theia/core` のルートコンテナで既にシングルトン束縛されている標準サービスのため、明示的な `bind()` は要らない)。新規コントリビューションクラスを追加する必要は無い、というのが本ブリーフの結論。

## 4. 希釈との整合

- `arschat-branding-frontend-module.ts:28-29` で `ArschatMenuFilterContribution` は `FilterContribution` として束縛されており、`registerContributionFilters()` (`arschat-ide-dilution.ts:143-168`) が `MenuContribution` から `TerminalFrontendContribution` を除外する。**これは `TerminalFrontendContribution.registerMenus()` が呼ばれなくなるだけで、`registerCommands()`/`registerKeybindings()`/`registerToolbarItems()` は別のインターフェース実装なので影響を受けない** — `contribution-provider.js` の `applyFilters(contributions, type)` は型ごとに独立してフィルタを適用する設計 (`arschat-ide-dilution.ts` 冒頭コメント L5-13 に明記、今回 node_modules 側の呼び出し元 `bindRootContributionProvider` 経由の multibinding 構造で裏取り済み)。
- 結論: **ms-11 は `arschat-ide-dilution.ts` を一切変更せずに実装できる** (SPEC の確定判断そのまま)。既存の M6 AUTOTEST (`arschat-m6-autotest-contribution.ts:165-179`) が `expectedAbsent = ['Run', 'Selection', 'Go', 'Terminal']` としてメニューバーに "Terminal" が無いことを既に回帰チェックしている — ms-11 実装後もこのテストが green のままであることが希釈整合性の一番手軽な確認手段になる。

## 5. 永続レイアウトとの絡み

### 5.1 再起動時にターミナルウィジェット自体は復元される

`ShellLayoutRestorer` は Theia 標準機構で、`TerminalWidget` の `WidgetFactory` (`TERMINAL_WIDGET_FACTORY_ID = 'terminal'`, `terminal-widget-impl.js:52`) が `terminal-frontend-module.js` に登録済みのため、ウィジェット自体 (タブ・見た目) は node_modules 側で無改変のまま復元される。ms-11 側で WidgetFactory を新規に書く必要はない。

### 5.2 復元時、裏のシェルプロセスは「再接続」ではなく「新規作成」になる (実測ベースの結論)

`TerminalWidgetImpl.storeState()`/`restoreState()` (`terminal-widget-impl.js:604-626`):
```js
storeState() {
    ...
    return { terminalId: this.terminalId, titleLabel: this.title.label, hasUserTitle: this.hasUserTitle, shellName: this._shellName };
}
restoreState(oldState) {
    ...
    this.start(state.terminalId);
}
```
`start(id)` → `attachTerminal(id)` (`terminal-widget-impl.js:644-658`):
```js
async attachTerminal(id) {
    const terminalId = await this.shellTerminalServer.attach(id);
    if (IBaseTerminalServer.validateId(terminalId)) { ... return terminalId; }
    this.logger.warn(`Failed attaching to terminal id ${id}, the terminal is most likely gone. Starting up a new terminal instead.`);
    if (this.kind === 'user') { return this.createTerminal(); }
    else { return -1; }
}
```
ArsChat は Electron アプリで、バックエンドは Electron プロセスと一体で起動・終了する (常駐リモートサーバーではない)。アプリを完全終了すれば旧バックエンドプロセスは消え、旧 `terminalId` の実体 (シェルプロセス) も一緒に消える。次回起動時は新しいバックエンドプロセスが立つため、`shellTerminalServer.attach(oldId)` は必ず失敗し、上記コードの `kind === 'user'` 分岐 (通常のユーザーターミナルはこれに該当) で **黙って新しいシェルプロセスが `createTerminal()` される**。つまり:
- 画面は壊れない (SPEC 受入条件 6 を満たす) — エラー表示にはならず、同じ位置に「新しいまっさらなターミナル」が復元される。
- ただし **旧セッションのコマンド履歴・カレントディレクトリ・実行中プロセスは失われる** (新規シェルなので当然、cwd は widget オプションの `cwd` が引き継がれていれば同じだが、`storeState()` の返り値には `cwd` が含まれていないため、`createTerminal()` 側の `this.options.cwd` 解決ロジック (`terminal-widget-impl.js:659-664`、ワークスペースルート優先) に依存する。ArsChat は基本ワークスペース無しなので `cwd` は未指定になり、シェルのデフォルト起動ディレクトリになる可能性が高い)。実機確認で「再起動後、前回の cwd で無くても問題ないか」をユーザー体感として確認しておくとよい (SPEC は cwd 引き継ぎを受入条件にしていないため、壊れていなければ十分)。

### 5.3 壊れうるポイント

- §0-3 で述べた「フレッシュプロファイルで `TerminalFrontendContribution.initializeLayout()` が下パネルに未展開のターミナルを1つ自動生成する」件は、ms-11 のボタン実装と無関係に **既に起きている既存動作**。ms-11 実装後にユーザーが初めてボタンを押したとき、`toggleTerminal()` は「下パネルに (非表示の) ターミナルが既に1つある」状態から始まる可能性があり、その場合 `terminals.length === 0` 分岐ではなく `expandPanel('bottom')` 分岐に入る (新規作成されない、既存の種ターミナルが表示される)。**動作としては正しい (受入条件は満たす) が、実機確認時に「ボタンを押したら真っ新なターミナルが出るはず」という思い込みで不具合と誤認しないよう注意。**
- `ArschatStaleIdeViewCleanup.onDidInitializeLayout()` (`arschat-stale-ide-view-cleanup.ts:75-84`) は `shell.getWidgets('left')`/`getWidgets('right')` のみを走査 (`arschat-stale-ide-view-cleanup.ts:91-94`) するため、下パネルのターミナルウィジェットは対象外 — 誤って閉じられる心配は無い (SPEC 「関連」欄の記述どおり、確認済み)。

## 6. Windows 固有の注意

### 6.1 node-pty のネイティブビルド: 過去に成功実績あり (確認済み事実)

`BUILD_NOTES.md:46-47` (足場構築時点、2026-07-04):
> `node-pty` / `keytar` / `drivelist` / `native-keymap` 等のネイティブアドオンの再ビルドは **無修正で成功**。既存ArsChatでnode-ptyが動く環境だったため、Windowsネイティブビルドツール(MSVC/Python等)は問題なく機能した。

さらに `BUILD_NOTES.md:972` (別マイルストーンの検証記録) でも `node-pty` を含むネイティブアドオンをメインリポの `node_modules` から複製してビルドを通した実績がある。`electron-app/package.json:41` の `"rebuild": "theia rebuild:electron --cacheRoot .."` が `theia rebuild:electron` を呼ぶことで `node-pty` 等のネイティブアドオンを Electron の ABI に合わせて再ビルドする (`@theia/process`/`@theia/terminal` の依存として node-pty が入る想定。ルートの `node_modules/node-pty` に `binding.gyp`/`prebuilds` が存在することを確認済み)。**ms-11 は `@theia/terminal` を新規依存として追加するわけではない (既に全アプリの package.json に存在) ため、追加のネイティブビルド作業は不要。通常の `npm run rebuild`/`bundle` フローで足りる。**

### 6.2 既定シェルの決定 (未確認・実装/実機確認で要確認)

`terminal-frontend-contribution.js:246-254` (`contributeDefaultProfiles()`):
```js
if (OS.backend.isWindows) {
    this.contributedProfileStore.registerTerminalProfile('cmd', new ShellTerminalProfile(this, {
        shellPath: await this.resolveShellPath(['${env:windir}\\Sysnative\\cmd.exe', '${env:windir}\\System32\\cmd.exe'])
    }));
}
```
Windows では `cmd` プロファイルが1つ登録される。ただし実際の既定プロファイル解決は `terminal.integrated.defaultProfile.windows` preference (`electron-app/package.json` の `theia.frontend.config.preferences` には設定なし = 未設定) に依存し、Theia 側で PowerShell 自動検出等の追加ロジックがある可能性がある (`terminal-preferences.ts`/`terminal-profile-service.ts` 側、今回は深追いしていない)。**「開いたターミナルが cmd か PowerShell か」は実機確認が必要**。SPEC のスコープ外 (プロファイル設定 UI はやらない) なので、既定のまま (Theia 任せ) で受入条件 3 (`dir`/`echo` の実行) さえ通れば良い。

## 7. AUTOTEST パターン (ARSCHAT_M11_AUTOTEST 案)

### 7.1 既存パターンの場所と仕組み

`arschat-chat/src/browser/arschat-m7-autotest-contribution.ts` が最新の型:
- `@injectable() export class ArschatM7AutotestContribution implements FrontendApplicationContribution`
- `@inject(EnvVariablesServer)` でバックエンド環境変数を読み、`ARSCHAT_M7_AUTOTEST !== '1'` なら即 return (`arschat-m7-autotest-contribution.ts:85-93`)
- `onStart()` で `setTimeout(() => this.run()..., 16000)` — 他の初期化 (モデル解決・チャット widget 生成等) が落ち着くのを待つための固定ディレイ
- `run()` が複数シナリオ (`scenarioXxx(): Promise<boolean>`) を順に呼び、`pass`/`fail` を集計して `[M7][autotest] SUMMARY: N PASS / M FAIL` を `console.log` + `ILogger.info` の両方に出す (`log()` ヘルパー, L80-83)
- 各シナリオは実際の `ArschatChatWidget` を `WidgetManager.getWidget()` で取得し、`widget.node.querySelector(...)` で実 DOM を叩く (モックDOMではなく本物のウィジェット)
- `arschat-chat-frontend-module.ts:79-80` で `bind(ArschatM7AutotestContribution).toSelf().inSingletonScope(); bind(FrontendApplicationContribution).toService(...)` として登録

### 7.2 ARSCHAT_M11_AUTOTEST 実装案

新規ファイル `arschat-chat/src/browser/arschat-m11-autotest-contribution.ts` (パッケージは `arschat-chat` — ボタンが `ArschatChatWidget` にあるため、既存 M3/M6/M7 と同じ置き場所が自然。下パネル/`ApplicationShell` へのアクセスは `arschat-chat` 側から可能 `@theia/core` 標準サービスなので新規パッケージ依存は不要)。

検証シナリオ案 (LLM 呼び出し不要、モック LanguageModel の登録も不要な点で M7 より単純):
1. **ボタン存在確認**: `widget.node.querySelector('#arschat-terminal-toggle-button')` が存在する。
2. **開く**: ボタンを `click()` → `waitFor(() => shell.isExpanded('bottom') && shell.getWidgets('bottom').some(w => w.id.startsWith('terminal')))` (id プレフィックスは `TERMINAL_WIDGET_FACTORY_ID = 'terminal'` に基づく想定、実装時に実際の id 形式を `console.log` で確認してから固定すること)。
3. **閉じる**: もう一度ボタンを `click()` → `waitFor(() => !shell.isExpanded('bottom'))`。
4. **希釈回帰**: 追加で `menuRegistry.getMenu(MAIN_MENU_BAR)` に "Terminal" が無いこと (M6 AUTOTEST と同じ 手法、`arschat-m6-autotest-contribution.ts:165-179` を流用/参照) を再チェックしてもよい (must ではないが、ms-11 が希釈を壊していないことをこのマイルストーン専用テストでも保証できる)。

§0-3 の「フレッシュ環境では下パネルに既にターミナルが1個いる」既存動作があるため、**シナリオ2 (開く) の判定は「新規作成されたか」ではなく「展開されて見えるようになったか」で見ること**。テスト実行環境 (Electron 実機、`ARSCHAT_M11_AUTOTEST=1` 環境変数) によっては初回の `toggleTerminal()` 呼び出しで新規作成分岐に入るかもしれないため、どちらの分岐でも `isExpanded('bottom') === true` になることだけを assert するのが頑健。

`ApplicationShell`/`WidgetManager`/`EnvVariablesServer`/`ILogger` の注入は M7 と同じ (import元も同じ)。

## 8. Jest テスト方針

### 8.1 既存パターン (`arschat-chat-widget.test.ts`)

- DI: `new ContainerModule(bind => { bind(XxxService).toConstantValue({...} as unknown as XxxService); ... bind(ArschatChatWidget).toSelf(); })` → `new Container(); container.load(module); container.resolve<ArschatChatWidget>(ArschatChatWidget)` (`arschat-chat-widget.test.ts:100-225`)。
- `ArschatChatWidget` に新規 `@inject(CommandRegistry)` を追加すると、**このテストファイルの `beforeEach` 内 `ContainerModule` に `bind(CommandRegistry).toConstantValue({ executeCommand: jest.fn() } as unknown as CommandRegistry)` 相当の束縛を追加しないと `container.resolve()` が失敗する** (inversify は未束縛の `@inject` があると resolve 時に例外を投げる)。既存の77件超のテストが軒並み落ちるので、**実装時に真っ先にこの束縛追加を行うこと**。
- レンダリング検証は `render(widget.render())` (`@testing-library/react`) + `container.querySelector`/`fireEvent.click` パターン (MS10 ブリーフ §5.1 と同様の手法)。

### 8.2 ms-11 で追加するテスト案

- 「`.arschat-terminal-toggle-button` が描画される」: `render(widget.render())`; `element.container.querySelector('#arschat-terminal-toggle-button')` が truthy。
- 「クリックすると `commandRegistry.executeCommand` が `'workbench.action.terminal.toggleTerminal'` (または `TerminalCommands.TOGGLE_TERMINAL.id`) で呼ばれる」: `fireEvent.click(button)` 後、テスト側の `jest.fn()` モックの呼び出し引数を検証。
- **ターミナル本体 (`TerminalWidget`/pty/シェルプロセス) は一切モック不要。** ArsChat 側の責務は「正しいコマンド id で `CommandRegistry.executeCommand` を呼ぶこと」までであり、そのコマンドの中身 (下パネルの開閉・ウィジェット生成) は Theia 本体のテスト範囲であって jsdom 環境でシミュレートする対象ではない (`@theia/terminal` 自体を DI コンテナに実体で読み込む必要も無い)。MS10 ブリーフの「純粋関数/副作用/統合の3層」ほどの複雑さは不要 — **単純な「ボタンが正しいコマンドを呼ぶか」の1〜2ケースで十分**、というのが本ブリーフの結論。
- ボタンの活性状態 (今開いているかどうかを視覚的に反映する) をもし実装するなら `@inject(ApplicationShell)` も追加注入することになり、同様にテスト DI モジュールへの束縛追加が必要になる。§3.1 の推奨 (状態を持たないシンプルなトグルボタン) を採る場合はこの追加注入・追加束縛は不要。

## 9. 罠・注意点

1. **CommandRegistry 注入によるテストの一括修正が先行必須**: §8.1 のとおり、新規 `@inject` を1つ足すだけで既存の全 Jest テスト (95件、MS10時点) が resolve エラーで落ちる。実装の最初のコミットで「DI追加 + 既存テストの束縛修正」をワンセットにすること。
2. **IME ゲートとの干渉は無い (確認)**: ターミナルボタンは `<button onClick>` であり、`update()` の `composing` ゲート (`arschat-chat-widget.tsx:289-295`) やテキストエリアの uncontrolled 化 (`BUILD_NOTES.md:1142`) と直接絡む要素は無い。ボタンクリックで `this.update()` を呼ぶ必要すら無い (`commandRegistry.executeCommand` は widget の再描画とは独立した shell 側の処理のため)。唯一の理論的な接点は、IME 変換中にマウスでボタンをクリックした場合の `composing` フラグの扱いだが、MS10 ブリーフ §1.4 で述べた「テキストエリア外要素のクリック前に blur が先に走る」という React のフォーカス遷移順序がここでも成り立つため、実害は無いと考えられる (専用テストは過剰、必要なら気付いた範囲で確認する程度でよい)。
3. **チャット強制 activate (`ArschatChatContribution.onStart`) とターミナルのフォーカス**: `arschat-chat-contribution.ts:70-73` の `onStart()` は毎回起動時に `openView({ activate: true, reveal: true })` でチャットウィジェットを **main エリア**でアクティブ化する。ターミナルは **bottom エリア**の別ウィジェットなので、この force-activate とは領域が異なり直接の競合は無い。ただし「前回ターミナルを開いたまま終了 → 再起動 → チャットが強制アクティブ化される」という順序において、ターミナルが下パネルに復元された直後にチャットへフォーカスが奪われる体感は起こりうる (許容範囲、SPEC 受入条件に「再起動後もターミナルにフォーカスが残る」等の要求は無い)。
4. **`toggleTerminal()` は「アクティブな下パネルウィジェットがターミナル以外のとき」も考慮した分岐を持つ** (`visibleTerminal` が無い/`activeWidget !== visibleTerminal` の分岐、§3.1 引用コード参照)。ms-11 のスコープでは下パネルにターミナル以外のウィジェットが同居することは無い想定 (SPEC は「複数ターミナル管理・分割はやらない」としているのみで、下パネルに他ビューを置く話は無い) なので通常は気にしなくてよいが、**ユーザーがコマンドパレット等から他の下パネル系ビュー (例: 将来 Problems/Output 等を誰かが有効化した場合) を開いていたら、ArsChat のボタンの見た目 (常に「ターミナル」ラベル) と実際の挙動 (タブ切替が先に起きて即座には閉じない) がズレる可能性がある。現状 ArsChat には下パネル系の他ビューが無いため実害はゼロだが、コメントとして実装箇所に一言残しておくと親切。**
5. **`this.workspaceService` 未使用**: ArsChat は今のところワークスペースを扱う UI を持たないため `openTerminal()` の cwd 選択分岐 (§1.3) は基本発火しない想定だが、**「基本発火しない」は推測であり実測していない**。実機確認の際に一度、通常の (ワークスペース未オープンの) 状態でボタンを押して QuickPick が出ないことを確認するのが安全。
6. **AUTOTEST のウィジェット id 前提**: §7.2 で `w.id.startsWith('terminal')` を仮定したが、これは `TERMINAL_WIDGET_FACTORY_ID = 'terminal'` (`terminal-widget-impl.js:52`) からの推測であり、実際の widget.id フォーマット (`WidgetManager.getOrCreateWidget` が id をどう組み立てるか) は未確認。実装時に一度 `console.log` で確認してから assert を固定すること。

## 10. まとめ (作業順序の推奨)

1. `arschat-chat/package.json` の `dependencies` に `"@theia/terminal": "1.71.2"` を追加 (型付きで `TerminalCommands` を import するため。§3.1)。
2. `ArschatChatWidget` に `@inject(CommandRegistry)` を追加し、`toggleTerminal()` メソッドを実装 (`commandRegistry.executeCommand(TerminalCommands.TOGGLE_TERMINAL.id)`)。
3. `arschat-chat-widget.test.ts` の DI モジュールに `CommandRegistry` のフェイク束縛を追加し、既存テスト (95件) が resolve エラーなく通ることを確認 (§8.1、最優先で壊れを直す)。
4. ヘッダーの `.arschat-chat-header-controls` 末尾にボタン `#arschat-terminal-toggle-button` を追加 (§2.2)。`style/index.css` に軽微なクラスを追加。
5. §8.2 の Jest テスト (ボタン描画・クリックで正しいコマンド id を呼ぶこと) を追加。`yarn workspace arschat-chat test` で green を確認。
6. `arschat-m11-autotest-contribution.ts` を新規実装し (§7.2)、`arschat-chat-frontend-module.ts` に登録。既存の M3/M6/M7 AUTOTEST と同様に flag-gated (`ARSCHAT_M11_AUTOTEST=1`) にする。
7. `theia rebuild:electron` を含む通常ビルド (`npm run build:electron`) で node-pty 等のネイティブビルドが従来どおり通ることを確認 (§6.1、新規ビルド作業は不要な想定だが一応確認)。
8. 実機確認 (Electron): (a) ボタンでの開閉、(b) `dir`/`echo` 実行、(c) 一度開いたまま完全終了 → 再起動でレイアウトが壊れないこと、(d) メニューバーに Terminal が復活していないこと、(e) 初回起動 (または既存プロファイル) で下パネルに「種」ターミナルが既に存在するかどうかの実地確認 (§0-3・§5.3)。
9. `ARSCHAT_M11_AUTOTEST=1` での自動検証ログ取得。
10. `BUILD_NOTES.md` に実装メモ (裏取りした事実・実機確認結果・ハマった点) を追記。
